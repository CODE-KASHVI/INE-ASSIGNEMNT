import { describe, expect, it } from 'vitest';
import { toLogEntryDto, toProductDto } from '../src/types/dto';
import type { ScrapeLogRow, TrackedProductRow } from '../src/types/dto';

function baseRow(overrides: Partial<TrackedProductRow> = {}): TrackedProductRow {
  return {
    id: 'p1',
    canonical_url: 'https://demo.inelabteamdev.com/product/644',
    store_product_id: 644,
    name: 'Helix Phone X',
    category: 'Phones',
    image_url: null,
    currency: 'INR',
    current_price: null,
    previous_price: null,
    price_changed_at: null,
    current_stock: null,
    last_scraped_at: null,
    last_attempt_at: null,
    last_attempt_status: null,
    health_status: 'PENDING',
    consecutive_failures: 0,
    scrape_interval_hours: 2,
    scrape_lock_until: null,
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('toProductDto', () => {
  it('derives priceChange and priceChangePercent from current/previous, never stores them', () => {
    const dto = toProductDto(baseRow({ current_price: 5300, previous_price: 5450 }));
    expect(dto.priceChange).toBeCloseTo(-150);
    expect(dto.priceChangePercent).toBeCloseTo(-2.75, 1);
  });

  it('is null, not zero or NaN, when there is no previous price yet', () => {
    const dto = toProductDto(baseRow({ current_price: 999, previous_price: null }));
    expect(dto.priceChange).toBeNull();
    expect(dto.priceChangePercent).toBeNull();
  });

  it('does not divide by zero if previous_price were ever 0 (defensive — schema forbids it anyway)', () => {
    const dto = toProductDto(baseRow({ current_price: 100, previous_price: 0 }));
    expect(dto.priceChangePercent).toBeNull();
  });

  it('maps the url field from canonical_url, not from store_product_id alone', () => {
    const dto = toProductDto(baseRow());
    expect(dto.url).toBe('https://demo.inelabteamdev.com/product/644');
  });
});

function baseLog(overrides: Partial<ScrapeLogRow> = {}): ScrapeLogRow {
  return {
    created_at: '2026-09-20T07:17:34.140Z',
    run_id: 'run-1',
    attempt_number: 1,
    status: 'SUCCESS',
    will_retry: false,
    message: null,
    error_type: null,
    error_message: null,
    duration_ms: null,
    extracted_price: null,
    extracted_stock: null,
    extraction_method: null,
    ...overrides,
  };
}

describe('toLogEntryDto', () => {
  it('omits inapplicable fields on a SUCCESS row instead of null-filling them', () => {
    const dto = toLogEntryDto(
      baseLog({ status: 'SUCCESS', message: 'Scrape succeeded', duration_ms: 8269, extracted_price: 5300, extracted_stock: 'IN_STOCK' }),
    );
    expect(dto).not.toHaveProperty('errorType');
    expect(dto).not.toHaveProperty('errorMessage');
    expect(dto.extractedPrice).toBe(5300);
  });

  it('omits price/stock fields on a TIMEOUT row instead of pretending they were extracted', () => {
    const dto = toLogEntryDto(baseLog({ status: 'TIMEOUT', error_type: 'TIMEOUT', error_message: 'locator.click: Timeout 15000ms exceeded', duration_ms: 36734 }));
    expect(dto).not.toHaveProperty('extractedPrice');
    expect(dto).not.toHaveProperty('extractedStock');
    expect(dto.errorType).toBe('TIMEOUT');
  });
});

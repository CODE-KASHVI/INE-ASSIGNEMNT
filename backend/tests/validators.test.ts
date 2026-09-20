import { describe, expect, it } from 'vitest';
import { validateExtraction, validationFailureToScrapeError } from '../src/scraper/validators';
import type { RawExtraction } from '../src/scraper/validators';

const good: RawExtraction = {
  title: 'Wireless Headphones',
  priceText: '₹1,299.00',
  stockText: 'In Stock',
  priceSource: 'css:.price',
  stockSource: 'css:.stock',
};

function failureOf(raw: RawExtraction, options = {}) {
  const r = validateExtraction(raw, options);
  if (r.ok) throw new Error('expected validation to fail');
  return r;
}

describe('validateExtraction', () => {
  it('accepts a fully valid extraction and normalises it', () => {
    const r = validateExtraction(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.price).toBe(1299);
      expect(r.value.currency).toBe('INR');
      expect(r.value.stockStatus).toBe('IN_STOCK');
      expect(r.value.priceSource).toBe('css:.price');
    }
  });

  it('maps "Sold out" to OUT_OF_STOCK (a valid, storable snapshot)', () => {
    const r = validateExtraction({ ...good, stockText: 'Sold out' });
    expect(r.ok && r.value.stockStatus).toBe('OUT_OF_STOCK');
  });

  it('fails when price is missing', () => {
    expect(failureOf({ ...good, priceText: null }).code).toBe('MISSING_PRICE');
    expect(failureOf({ ...good, priceText: '  ' }).code).toBe('MISSING_PRICE');
  });

  it('fails on placeholder / malformed / ambiguous prices', () => {
    // NB: "12,99" is NOT in this list — the storefront's `euro` variant renders the decimal
    // separator as a comma, so a comma with two trailing digits is a real price here.
    for (const priceText of ['Loading...', '$NaN', 'abc', '₹0', '₹1,299 ₹1,499', '1,2,3']) {
      expect(failureOf({ ...good, priceText }).code).toBe('INVALID_PRICE');
    }
  });

  it('fails when stock text is missing — missing is NOT out of stock', () => {
    const f = failureOf({ ...good, stockText: null });
    expect(f.code).toBe('MISSING_STOCK');
  });

  it('fails on unrecognised or uncertain stock wording', () => {
    for (const stockText of ['Ships in 3-5 days', 'Pre-order', 'In stock and out of stock']) {
      expect(failureOf({ ...good, stockText }).code).toBe('UNCERTAIN_STOCK');
    }
  });

  it('fails when the page shows a different currency than expected, but accepts "no marker"', () => {
    expect(failureOf({ ...good, priceText: '$19.99' }, { expectedCurrency: 'INR' }).code).toBe('CURRENCY_MISMATCH');
    expect(validateExtraction({ ...good, priceText: '1,299' }, { expectedCurrency: 'INR' }).ok).toBe(true);
  });

  it('reports every problem, not just the first', () => {
    const f = failureOf({ ...good, priceText: 'Loading...', stockText: null });
    expect(f.problems.length).toBe(2);
  });
});

describe('validationFailureToScrapeError', () => {
  it('title present but price missing ⇒ STRUCTURE_CHANGED (retryable, in case of slow render)', () => {
    const raw = { ...good, priceText: null };
    const err = validationFailureToScrapeError(failureOf(raw), raw);
    expect(err.type).toBe('STRUCTURE_CHANGED');
    expect(err.retryable).toBe(true);
  });

  it('no title and no price ⇒ CONTENT_NOT_READY', () => {
    const raw = { ...good, title: null, priceText: null };
    expect(validationFailureToScrapeError(failureOf(raw), raw).type).toBe('CONTENT_NOT_READY');
  });

  it('invalid price ⇒ VALIDATION, with short sanitized diagnostics (no HTML)', () => {
    const raw = { ...good, priceText: 'Loading...' };
    const err = validationFailureToScrapeError(failureOf(raw), raw);
    expect(err.type).toBe('VALIDATION');
    expect(JSON.stringify(err.diagnostics).includes('<')).toBe(false);
  });
});

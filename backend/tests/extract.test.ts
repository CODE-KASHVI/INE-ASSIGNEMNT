/**
 * Every one of these cases is a trap the storefront actually sets. They run without a browser
 * because reveal.ts only collects a snapshot and extract.ts does all the deciding.
 */
import { describe, expect, it } from 'vitest';
import { interpretReading, parseBadgePercent } from '../src/scraper/extract';
import type { PriceBlockReading } from '../src/scraper/extract';
import type { StoreLayout } from '../src/scraper/selectors';
import { ScrapeError } from '../src/scraper/types';

/** The layout document captured by the probe on 2026-09-20. */
const layout: StoreLayout = {
  revision: 627000,
  variant: 4,
  validUntil: Date.now() + 3_600_000,
  classes: { priceWrap: 'pw-z6', priceValue: 'pv-z6', mrp: 'mr-z6', sale: 'sl-z6', badge: 'bd-z6', rating: 'rt-z6', seller: 'sr-z6', delivery: 'dl-z6', stock: 'st-z6' },
  priceTag: 'span',
  priceCarrier: 'text',
  order: ['rating', 'seller', 'delivery', 'stock'],
};

/** A clean, revealed price block: ₹1,29,900 off a ₹1,49,900 list price, 15% badge. */
const good: PriceBlockReading = {
  phase: 'success',
  titleText: 'Summit Soundbar S',
  statusText: null,
  substatusText: null,
  priceText: '₹1,29,900',
  priceMatchCount: 1,
  priceVisible: true,
  mrpText: '₹1,49,900',
  badgeText: '13% off',
  pending: false,
  stockText: 'Only 4 left',
  stockBadgeKind: 'in-stock',
  visibleDecoys: [],
};

function errorFor(reading: Partial<PriceBlockReading>): ScrapeError {
  try {
    interpretReading({ ...good, ...reading }, layout);
  } catch (error) {
    if (error instanceof ScrapeError) return error;
    throw error;
  }
  throw new Error('expected interpretReading to throw');
}

describe('interpretReading — the happy path', () => {
  it('accepts a revealed, self-consistent price block', () => {
    const raw = interpretReading(good, layout);
    expect(raw.title).toBe('Summit Soundbar S');
    expect(raw.priceText).toBe('₹1,29,900');
    expect(raw.stockText).toBe('Only 4 left');
    // The source string records the layout revision, so a log row explains itself later.
    expect(raw.priceSource).toContain('r627000');
    expect(raw.priceSource).toContain('pv-z6');
  });
});

describe('interpretReading — the decoys', () => {
  it('fails loudly if a hidden decoy price ever becomes visible', () => {
    const error = errorFor({ visibleDecoys: ['.price-value'] });
    expect(error.type).toBe('STRUCTURE_CHANGED');
    expect(error.message).toContain('Decoy');
  });

  it('refuses a price element that is hidden — that is what a decoy looks like', () => {
    expect(errorFor({ priceVisible: false }).type).toBe('STRUCTURE_CHANGED');
  });

  it('refuses when the layout class matches more than one element', () => {
    expect(errorFor({ priceMatchCount: 2 }).type).toBe('STRUCTURE_CHANGED');
  });

  it('refuses when the layout class matches nothing despite a successful reveal', () => {
    const error = errorFor({ priceMatchCount: 0 });
    expect(error.type).toBe('STRUCTURE_CHANGED');
    // Retryable: the class may simply have rotated, and the next attempt re-reads /api/layout.
    expect(error.retryable).toBe(true);
  });
});

describe('interpretReading — plausibility against mrp and the discount badge', () => {
  it('rejects a selling price above the struck-through list price', () => {
    expect(errorFor({ priceText: '₹1,59,900' }).type).toBe('VALIDATION');
  });

  it('rejects a price that contradicts the discount badge', () => {
    // A decoy is the real price scaled by a random 0.6–1.3 factor; 0.7x lands far outside.
    expect(errorFor({ priceText: '₹90,000' }).type).toBe('VALIDATION');
  });

  it('tolerates the rounding slack of an integer badge percentage', () => {
    // 1,49,900 less 13% = 1,30,413 — 0.4% away from the shown 1,29,900.
    expect(() => interpretReading(good, layout)).not.toThrow();
  });

  it('can be downgraded to a diagnostic when a store change makes the check unreliable', () => {
    expect(() => interpretReading({ ...good, priceText: '₹90,000' }, layout, { enforceConsistency: false })).not.toThrow();
  });

  it('skips the check when the badge or mrp is absent rather than inventing a failure', () => {
    expect(() => interpretReading({ ...good, badgeText: null, mrpText: null }, layout)).not.toThrow();
  });
});

describe('interpretReading — phases and staleness', () => {
  it('refuses to read a block that never left the idle phase', () => {
    const error = errorFor({ phase: 'idle', priceText: null, priceMatchCount: 0, statusText: 'Price hidden' });
    expect(error.type).toBe('CONTENT_NOT_READY');
  });

  it('reports the storefront giving up as CONTENT_NOT_READY, with its own message', () => {
    const error = errorFor({ phase: 'error', substatusText: 'quote 429' });
    expect(error.type).toBe('CONTENT_NOT_READY');
    expect(error.message).toContain('429');
  });

  it('refuses a quote the storefront itself flagged as pending', () => {
    const error = errorFor({ pending: true });
    expect(error.type).toBe('VALIDATION');
    expect(error.message).toContain('pending');
  });

  it('treats a missing <h1> as an unrendered page, not as a missing price', () => {
    expect(errorFor({ titleText: null }).type).toBe('CONTENT_NOT_READY');
  });
});

describe('interpretReading — stock cross-check', () => {
  it('refuses when the badge class and its wording disagree', () => {
    expect(errorFor({ stockBadgeKind: 'out-stock', stockText: 'Only 4 left' }).type).toBe('VALIDATION');
    expect(errorFor({ stockBadgeKind: 'in-stock', stockText: 'Out of stock' }).type).toBe('VALIDATION');
  });

  it('passes an out-of-stock block straight through — it is a valid observation', () => {
    const raw = interpretReading({ ...good, stockBadgeKind: 'out-stock', stockText: 'Out of stock' }, layout);
    expect(raw.stockText).toBe('Out of stock');
  });

  it('never stores page HTML in diagnostics', () => {
    const error = errorFor({ pending: true });
    expect(JSON.stringify(error.diagnostics)).not.toContain('<');
  });
});

describe('parseBadgePercent', () => {
  it('reads the badge and shrugs off anything else', () => {
    expect(parseBadgePercent('13% off')).toBe(13);
    expect(parseBadgePercent(' 7 % off ')).toBe(7);
    expect(parseBadgePercent('off')).toBeNull();
    expect(parseBadgePercent(null)).toBeNull();
  });
});

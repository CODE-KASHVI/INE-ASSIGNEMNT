/**
 * The storefront picks one of five in-stock wordings at render time (bundle: `Rr`, indexed by
 * the unit count), so a scraper that only knows "In Stock" reads four-fifths of pages as
 * unknown. All five are generated here the way the store generates them.
 */
import { describe, expect, it } from 'vitest';
import { parseStock } from '../src/scraper/parser';

/** Port of the bundle's `zr(units)` — the template is chosen by `units % 5`. */
const STORE_TEMPLATES: Array<(units: number) => string> = [
  (n) => `In stock · ${n} left`,
  (n) => `Only ${n} left`,
  (n) => `${n} in stock`,
  (n) => `Selling fast — ${n} left`,
  (n) => `Hurry, just ${n} left`,
];
const renderStock = (units: number): string => (STORE_TEMPLATES[units % STORE_TEMPLATES.length] as (n: number) => string)(units);

describe('parseStock — the storefront vocabulary', () => {
  it('reads all five in-stock templates and recovers the unit count', () => {
    for (let units = 1; units <= 25; units += 1) {
      const text = renderStock(units);
      const result = parseStock(text);
      expect(result.status, `${text} → ${JSON.stringify(result)}`).toBe('IN_STOCK');
      expect(result.quantity).toBe(units);
      expect(result.matched?.startsWith('ine:')).toBe(true);
    }
  });

  it('reads the single out-of-stock wording', () => {
    const result = parseStock('Out of stock');
    expect(result.status).toBe('OUT_OF_STOCK');
    expect(result.matched).toBe('ine:out-of-stock');
  });

  it('survives the zero-width separators the split carrier inserts', () => {
    expect(parseStock('O\u200Bn\u200Bl\u200By\u200B \u200B3\u200B \u200Bl\u200Be\u200Bf\u200Bt').status).toBe('IN_STOCK');
  });

  it('still understands the generic wordings a redesign might introduce', () => {
    expect(parseStock('In Stock').status).toBe('IN_STOCK');
    expect(parseStock('Available').status).toBe('IN_STOCK');
    expect(parseStock('Sold out').status).toBe('OUT_OF_STOCK');
    expect(parseStock('Currently unavailable').status).toBe('OUT_OF_STOCK');
  });
});

describe('parseStock — refusals (the rule that matters)', () => {
  it('treats missing text as UNKNOWN, never as out of stock', () => {
    for (const input of [null, undefined, '', '   ']) {
      const result = parseStock(input);
      expect(result.status).toBe('UNKNOWN');
      expect(result.reason).toBe('EMPTY');
    }
  });

  it('treats unrecognised wording as UNKNOWN, never as out of stock', () => {
    for (const input of ['Ships in 3-5 days', 'Pre-order', 'Notify me', 'Backordered']) {
      const result = parseStock(input);
      expect(result.status).toBe('UNKNOWN');
      expect(result.reason).toBe('UNRECOGNIZED');
    }
  });

  it('refuses to pick a winner when the text says both', () => {
    const result = parseStock('In stock and out of stock');
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('CONFLICT');
  });

  it('refuses self-contradictory counts rather than guessing', () => {
    const result = parseStock('Only 0 left');
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('CONFLICT');
  });
});

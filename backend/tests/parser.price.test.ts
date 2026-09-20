/**
 * The important part of this file is `renderLikeStorefront`: it is the storefront's own
 * formatter, ported verbatim from assets/index-B9UiQq4X.js. Testing against strings we
 * invented would only prove the parser is self-consistent; generating them the way the store
 * generates them proves we parse what the store actually renders — in all seven formats, with
 * and without the per-character `split` carrier.
 */
import { describe, expect, it } from 'vitest';
import { detectCurrencies, normalizePriceText, parsePrice } from '../src/scraper/parser';

const NBSP = '\u00A0';
const ZWSP = '\u200B';

type StoreFormat = 'plain' | 'spaced' | 'euro' | 'trailing' | 'unicode' | 'nbsp' | 'lakh';

const baseFormat = (amount: number, currency = 'INR'): string =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);

/** Port of the bundle's `Ir(value, currency, format)`. */
function renderLikeStorefront(amount: number, format: StoreFormat): string {
  const base = baseFormat(amount);
  switch (format) {
    case 'spaced':
      return base.replace(/,/g, ' ');
    case 'euro':
      return `${base.replace(/,/g, '.')},00`;
    case 'trailing':
      return `${base}/- (incl. of all taxes)`;
    case 'unicode':
      return base.replace(/[0-9]/g, (d) => String.fromCharCode(65296 + Number(d)));
    case 'nbsp':
      return base.split('').join(NBSP + ZWSP);
    case 'lakh':
      return `Rs.${NBSP}${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2 }).format(amount)}`;
    default:
      return base;
  }
}

/** Port of the bundle's `Lr()` — applied when layout.priceCarrier === "split". */
const withSplitCarrier = (text: string): string => text.split('').join(ZWSP);

const FORMATS: StoreFormat[] = ['plain', 'spaced', 'euro', 'trailing', 'unicode', 'nbsp', 'lakh'];
const AMOUNTS = [7, 42, 499, 1299, 12999, 129900, 1299000];

describe('parsePrice — every format the storefront can render', () => {
  for (const format of FORMATS) {
    for (const carrier of ['text', 'split'] as const) {
      it(`reads ${format} prices with the ${carrier} carrier`, () => {
        for (const amount of AMOUNTS) {
          const rendered = carrier === 'split' ? withSplitCarrier(renderLikeStorefront(amount, format)) : renderLikeStorefront(amount, format);
          const result = parsePrice(rendered);
          expect(result.ok, `${format}/${carrier} ${amount}: ${JSON.stringify(rendered)} → ${JSON.stringify(result)}`).toBe(true);
          if (result.ok) {
            expect(result.value.amount).toBe(amount);
            expect(result.value.currency).toBe('INR');
          }
        }
      });
    }
  }

  it('handles Indian lakh grouping, not just thousands', () => {
    expect(parsePrice('₹1,29,900')).toMatchObject({ ok: true, value: { amount: 129900 } });
    expect(parsePrice('₹1,299,000')).toMatchObject({ ok: true, value: { amount: 1299000 } });
  });

  it('treats a comma with three trailing digits as grouping and with two as a decimal', () => {
    // The base format uses maximumFractionDigits: 0, so ",299" is never a fraction …
    expect(parsePrice('₹1,299')).toMatchObject({ ok: true, value: { amount: 1299 } });
    // … while the `euro` variant genuinely uses a comma as the decimal separator.
    expect(parsePrice('₹12,99')).toMatchObject({ ok: true, value: { amount: 12.99 } });
  });
});

describe('normalizePriceText', () => {
  it('strips the zero-width and non-breaking junk the split/nbsp renderers insert', () => {
    expect(normalizePriceText(`₹${NBSP}${ZWSP}1${NBSP}${ZWSP},${NBSP}${ZWSP}2${NBSP}${ZWSP}9${NBSP}${ZWSP}9`)).toBe('₹1,299');
  });

  it('converts fullwidth digits', () => {
    expect(normalizePriceText('₹１２９')).toBe('₹129');
  });

  it('drops the trailing tax blurb', () => {
    expect(normalizePriceText('₹1,299/- (incl. of all taxes)')).toBe('₹1,299');
  });

  it('leaves ordinary spaces alone — they are group separators in the spaced format', () => {
    expect(normalizePriceText('₹1 29 900')).toBe('₹1 29 900');
  });
});

describe('parsePrice — refusals', () => {
  const cases: Array<[string | null, string]> = [
    [null, 'EMPTY'],
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['—', 'EMPTY'],
    ['Price hidden', 'PLACEHOLDER'],
    ['Loading current price…', 'PLACEHOLDER'],
    ['Updating…', 'PLACEHOLDER'],
    ['Hold on — checking availability…', 'PLACEHOLDER'],
    ['no digits here', 'NO_NUMBER'],
    ['₹1,299 ₹1,499', 'MULTIPLE_PRICES'],
    ['₹1,299 / $19.99', 'MULTIPLE_CURRENCIES'],
    ['₹1,2999', 'AMBIGUOUS_SEPARATORS'],
    ['1299.4567', 'AMBIGUOUS_SEPARATORS'],
    ['₹1,2,3', 'INVALID_GROUPING'],
    ['₹0', 'NON_POSITIVE'],
    ['₹99,99,99,99,999', 'OUT_OF_RANGE'],
  ];

  for (const [input, reason] of cases) {
    it(`refuses ${JSON.stringify(input)} with ${reason}`, () => {
      const result = parsePrice(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    });
  }

  it('never rounds silently — more decimals than allowed is a refusal, not a round', () => {
    const result = parsePrice('1299.45', { maxDecimals: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('TOO_MANY_DECIMALS');
  });
});

describe('detectCurrencies', () => {
  it('recognises both symbols the storefront uses for rupees', () => {
    expect(detectCurrencies('₹1,299')).toEqual(['INR']);
    expect(detectCurrencies('Rs.1,299.00')).toEqual(['INR']);
  });
});

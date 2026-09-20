import { parsePrice, parseStock } from './parser';
import type { ParsedPrice, PriceParseOptions } from './parser';
import { ScrapeError } from './types';
import type { ConfirmedStockStatus } from './types';

/** What the extraction layer (Cheerio or Playwright) hands over: raw text only, nothing trusted yet. */
export interface RawExtraction {
  title: string | null;
  priceText: string | null;
  stockText: string | null;
  /** Which selector / strategy produced each value (e.g. "css:[itemprop=price]", "jsonld:offers.price"). */
  priceSource: string | null;
  stockSource: string | null;
}

/** The only shape that may be written to price_history. */
export interface ValidatedSnapshot {
  price: number;
  currency: string | null;
  stockStatus: ConfirmedStockStatus;
  rawPriceText: string;
  rawStockText: string;
  priceSource: string | null;
  stockSource: string | null;
}

export interface ValidationOptions {
  price?: PriceParseOptions;
  /** If set and the page shows a *different* currency marker, the scrape fails. No marker ⇒ accepted. */
  expectedCurrency?: string | null;
}

export type ValidationFailureCode = 'MISSING_PRICE' | 'INVALID_PRICE' | 'CURRENCY_MISMATCH' | 'MISSING_STOCK' | 'UNCERTAIN_STOCK';

export type ValidationResult =
  | { ok: true; value: ValidatedSnapshot }
  | { ok: false; code: ValidationFailureCode; problems: string[]; message: string };

/**
 * Rule enforced here: if price OR stock cannot be determined confidently, the result is a failure.
 * Missing stock text is NOT out-of-stock; unrecognised stock wording is NOT out-of-stock.
 */
export function validateExtraction(raw: RawExtraction, options: ValidationOptions = {}): ValidationResult {
  const problems: Array<{ code: ValidationFailureCode; message: string }> = [];

  let price: ParsedPrice | null = null;
  const priceResult = parsePrice(raw.priceText, options.price);
  if (!priceResult.ok) {
    problems.push({
      code: priceResult.reason === 'EMPTY' ? 'MISSING_PRICE' : 'INVALID_PRICE',
      message: `price ${priceResult.reason}: ${priceResult.detail} (raw: "${priceResult.rawText}")`,
    });
  } else if (options.expectedCurrency && priceResult.value.currency && priceResult.value.currency !== options.expectedCurrency) {
    problems.push({
      code: 'CURRENCY_MISMATCH',
      message: `expected ${options.expectedCurrency} but page shows ${priceResult.value.currency}`,
    });
  } else {
    price = priceResult.value;
  }

  const stock = parseStock(raw.stockText);
  if (stock.status === 'UNKNOWN') {
    problems.push({
      code: stock.reason === 'EMPTY' ? 'MISSING_STOCK' : 'UNCERTAIN_STOCK',
      message: `stock ${stock.reason} (raw: "${stock.rawText}")`,
    });
  }

  const first = problems[0];
  if (first || !price || stock.status === 'UNKNOWN') {
    return {
      ok: false,
      code: first?.code ?? 'INVALID_PRICE',
      problems: problems.map((p) => p.message),
      message: problems.map((p) => p.message).join('; ') || 'validation failed',
    };
  }

  return {
    ok: true,
    value: {
      price: price.amount,
      currency: price.currency,
      stockStatus: stock.status,
      rawPriceText: price.rawText,
      rawStockText: stock.rawText,
      priceSource: raw.priceSource,
      stockSource: raw.stockSource,
    },
  };
}

/**
 * Classifies a validation failure:
 *  - no price text + title present  ⇒ STRUCTURE_CHANGED (page rendered, but none of our selectors found a price)
 *  - no price text + no title       ⇒ CONTENT_NOT_READY (blank / error / not-yet-rendered page)
 *  - anything else                  ⇒ VALIDATION
 * All are retryable; if every attempt fails the same way, the terminal log status makes the cause obvious.
 * Diagnostics contain short, sanitized strings only — never page HTML.
 */
export function validationFailureToScrapeError(
  failure: Extract<ValidationResult, { ok: false }>,
  raw: RawExtraction,
): ScrapeError {
  const diagnostics = {
    code: failure.code,
    problems: failure.problems,
    titleFound: Boolean(raw.title),
    priceText: raw.priceText?.slice(0, 120) ?? null,
    stockText: raw.stockText?.slice(0, 120) ?? null,
    priceSource: raw.priceSource,
    stockSource: raw.stockSource,
  };

  if (failure.code === 'MISSING_PRICE') {
    return raw.title
      ? new ScrapeError('STRUCTURE_CHANGED', 'Product title found but no known price selector matched', { diagnostics })
      : new ScrapeError('CONTENT_NOT_READY', 'Page has no product title or price (not rendered, or an error page)', { diagnostics });
  }
  return new ScrapeError('VALIDATION', failure.message, { diagnostics });
}

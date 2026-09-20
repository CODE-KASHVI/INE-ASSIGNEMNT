/**
 * Pure text → value parsing. No browser, no network, no DB — cheap to unit test.
 *
 * Philosophy: when in doubt, fail. A rejected scrape is visible and harmless; a
 * wrongly-parsed price is invisible and corrupts history forever.
 *
 * Everything here is driven by what the storefront actually renders. From the bundle, the
 * price string is produced by ONE of six rotating formatters (layout.variant picks it), all
 * built on `Intl.NumberFormat('en-IN', { style: 'currency', maximumFractionDigits: 0 })`:
 *
 *   default   ₹1,29,900                       (en-IN "lakh" grouping: 1,29,900 not 129,900)
 *   spaced    ₹1 29 900                       commas replaced with spaces
 *   euro      ₹1.29.900,00                    commas → dots, then ",00" appended
 *   trailing  ₹1,29,900/- (incl. of all taxes)
 *   unicode   ₹１,２９,９００                    ASCII digits → U+FF10..U+FF19
 *   nbsp      ₹<NBSP><ZWSP>1<NBSP><ZWSP>,…    every character separated by NBSP + U+200B
 *   lakh      Rs.<NBSP>1,29,900.00            different symbol, two forced decimals
 *
 * On top of that, when layout.priceCarrier === "split" each character is wrapped in its own
 * <span> joined by U+200B, so textContent gains zero-width junk in any of the six formats.
 *
 * The decimal separator therefore cannot be a constant. It is detected per string, and any
 * string whose grouping does not look like real grouping is rejected rather than guessed at.
 */
import type { StockStatus } from './types';

// ───────────────────────────── shared text hygiene ─────────────────────────────

/**
 * Zero-width / bidi / formatting characters. They carry no meaning for a reader and the
 * storefront injects them between characters, so they are removed before any parsing.
 */
const INVISIBLE_CHARS = /[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * Non-breaking and exotic spaces. The `nbsp` and `lakh` formats use U+00A0 purely as a visual
 * separator, so it is DELETED, not converted to a space — converting it would turn
 * "₹<NBSP>1<NBSP>,…" into something indistinguishable from the space-grouped format.
 * Ordinary ASCII spaces are left alone: in the `spaced` format they are real group separators.
 */
const FORMATTING_SPACES = /[\u00a0\u2007\u202f\u2009\u2008\u2006\u2005\u2004\u2003\u2002]/g;

/** Trailing sales blurb from the `trailing` format. */
const TRAILING_BLURB = /\/-\s*(?:\(\s*incl\.?[^)]*\))?/gi;

const FULLWIDTH_DIGIT_START = 0xff10; // '０'

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_CHARS, '');
}

/** U+FF10..U+FF19 → 0..9 (the `unicode` format). */
export function normalizeDigits(text: string): string {
  return text.replace(/[\uff10-\uff19]/g, (ch) => String(ch.codePointAt(0)! - FULLWIDTH_DIGIT_START));
}

/**
 * Collapses every rotating render format back to a plain "<symbol><number>" string.
 * Exported so tests can assert the normalisation step on its own.
 */
export function normalizePriceText(raw: string): string {
  return normalizeDigits(stripInvisible(raw))
    .replace(FORMATTING_SPACES, '')
    .replace(TRAILING_BLURB, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ───────────────────────────── price ─────────────────────────────

export type PriceFailureReason =
  | 'EMPTY'
  | 'PLACEHOLDER'
  | 'NO_NUMBER'
  | 'MULTIPLE_PRICES'
  | 'MULTIPLE_CURRENCIES'
  | 'AMBIGUOUS_SEPARATORS'
  | 'INVALID_GROUPING'
  | 'TOO_MANY_DECIMALS'
  | 'NON_POSITIVE'
  | 'OUT_OF_RANGE';

export interface ParsedPrice {
  amount: number;
  /** ISO code when a marker was present (₹ / Rs. → INR), otherwise null. */
  currency: string | null;
  /** Which of the six render formats the string looked like. Stored in logs, handy for triage. */
  detectedFormat: PriceFormatHint;
  rawText: string;
  normalizedText: string;
}

export type PriceFormatHint = 'plain' | 'spaced' | 'euro' | 'trailing' | 'unicode' | 'nbsp' | 'lakh';

export type PriceParseResult =
  | { ok: true; value: ParsedPrice }
  | { ok: false; reason: PriceFailureReason; detail: string; rawText: string };

export interface PriceParseOptions {
  /** More fractional digits than this ⇒ rejection rather than silent rounding. */
  maxDecimals?: number;
  /** Sanity ceiling; anything above is treated as a mis-parse. */
  maxPlausiblePrice?: number;
}

const PRICE_DEFAULTS = { maxDecimals: 2, maxPlausiblePrice: 10_000_000 } as const;

const CURRENCY_MARKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/₹|\brs\.?|\binr\b/i, 'INR'],
  [/\$|\busd\b/i, 'USD'],
  [/€|\beur\b/i, 'EUR'],
  [/£|\bgbp\b/i, 'GBP'],
];

/** Text that is a rendering artefact, not a price. */
const PLACEHOLDER_WORDS = /\b(?:loading|updating|please wait|fetching|checking|calculating|hidden|nan|undefined|null|n\/a|tbd)\b/i;
const PLACEHOLDER_SYMBOLS = /^[\s\-–—_.…?*#]*$/;

/** A digit run that may contain grouping/decimal separators, always starting and ending on a digit. */
const NUMBER_TOKEN = /\d(?:[\d.,\u0020]*\d)?/g;

export function detectCurrencies(text: string): string[] {
  const found = new Set<string>();
  for (const [pattern, code] of CURRENCY_MARKERS) if (pattern.test(text)) found.add(code);
  return [...found];
}

function formatHint(raw: string, normalized: string): PriceFormatHint {
  if (/[\uff10-\uff19]/.test(raw)) return 'unicode';
  if (/\u200b/.test(raw) && /\u00a0/.test(raw)) return 'nbsp';
  if (/\/-/.test(raw)) return 'trailing';
  if (/rs\.?/i.test(normalized)) return 'lakh';
  if (/\d\.\d{3}(?:\D|$)/.test(normalized) && /,\d{2}$/.test(normalized)) return 'euro';
  if (/\d \d/.test(normalized)) return 'spaced';
  return 'plain';
}

/**
 * Decides which separator (if any) is the decimal point.
 *
 * - Two different separator characters present ⇒ the LAST one is the decimal, and it must
 *   appear exactly once with 1–2 digits after it (euro: 1.29.900,00 / lakh: 1,29,900.00).
 * - One separator character:
 *     · appears more than once                 ⇒ grouping (1,29,900)
 *     · followed by exactly 3 digits           ⇒ grouping (1,299) — the store's base format
 *                                                 has maximumFractionDigits: 0, so a 3-digit
 *                                                 tail is never a fraction
 *     · followed by 1–2 digits                 ⇒ decimal (1299.50)
 * - Space is only ever a group separator.
 */
function detectDecimalSeparator(token: string): { decimal: '.' | ',' | null; error?: PriceFailureReason } {
  const dots = (token.match(/\./g) ?? []).length;
  const commas = (token.match(/,/g) ?? []).length;

  if (dots > 0 && commas > 0) {
    const lastDot = token.lastIndexOf('.');
    const lastComma = token.lastIndexOf(',');
    const decimal: '.' | ',' = lastDot > lastComma ? '.' : ',';
    const count = decimal === '.' ? dots : commas;
    const tail = token.slice(token.lastIndexOf(decimal) + 1);
    if (count !== 1 || !/^\d{1,2}$/.test(tail)) return { decimal: null, error: 'AMBIGUOUS_SEPARATORS' };
    return { decimal };
  }

  const sep: '.' | ',' | null = dots > 0 ? '.' : commas > 0 ? ',' : null;
  if (!sep) return { decimal: null };
  const count = sep === '.' ? dots : commas;
  if (count > 1) return { decimal: null };
  const tail = token.slice(token.lastIndexOf(sep) + 1);
  if (/^\d{3}$/.test(tail)) return { decimal: null }; // grouping
  if (/^\d{1,2}$/.test(tail)) return { decimal: sep };
  return { decimal: null, error: 'AMBIGUOUS_SEPARATORS' };
}

/**
 * Accepts both Western (1,299,000) and Indian (12,99,000) grouping, which en-IN produces:
 * first group 1–3 digits, middle groups 2–3 digits, final group exactly 3 digits.
 * Ungrouped integers are fine. Anything else is a mis-parse, not a price.
 */
function isValidGrouping(intPart: string): boolean {
  const parts = intPart.split(/[.,\u0020]/);
  if (parts.length === 1) return /^\d+$/.test(parts[0] as string);
  if (!/^\d{1,3}$/.test(parts[0] as string)) return false;
  for (let i = 1; i < parts.length - 1; i += 1) if (!/^\d{2,3}$/.test(parts[i] as string)) return false;
  return /^\d{3}$/.test(parts[parts.length - 1] as string);
}

export function parsePrice(raw: string | null | undefined, options: PriceParseOptions = {}): PriceParseResult {
  const settings = { ...PRICE_DEFAULTS, ...options };
  const rawText = raw ?? '';
  const fail = (reason: PriceFailureReason, detail: string): PriceParseResult => ({ ok: false, reason, detail, rawText });

  if (!rawText.trim()) return fail('EMPTY', 'no text supplied');

  const text = normalizePriceText(rawText);
  if (!text || PLACEHOLDER_SYMBOLS.test(text)) return fail('EMPTY', 'text contains no characters after normalisation');
  if (PLACEHOLDER_WORDS.test(text)) return fail('PLACEHOLDER', 'text looks like a loading/placeholder state');

  const currencies = detectCurrencies(text);
  if (currencies.length > 1) return fail('MULTIPLE_CURRENCIES', `found ${currencies.join(', ')}`);

  const tokens = text.match(NUMBER_TOKEN) ?? [];
  if (tokens.length === 0) return fail('NO_NUMBER', 'no digits found');
  if (tokens.length > 1) return fail('MULTIPLE_PRICES', `found ${tokens.length} numbers: ${tokens.join(' | ')}`);

  const token = tokens[0] as string;
  const { decimal, error } = detectDecimalSeparator(token);
  if (error) return fail(error, `cannot tell grouping from decimals in "${token}"`);

  const splitAt = decimal ? token.lastIndexOf(decimal) : -1;
  const intPart = splitAt >= 0 ? token.slice(0, splitAt) : token;
  const fracPart = splitAt >= 0 ? token.slice(splitAt + 1) : '';

  if (fracPart.length > settings.maxDecimals) {
    return fail('TOO_MANY_DECIMALS', `${fracPart.length} fractional digits in "${token}"`);
  }
  if (!isValidGrouping(intPart)) {
    return fail('INVALID_GROUPING', `"${intPart}" is not a plausibly grouped integer`);
  }

  const digitsOnly = intPart.replace(/[.,\u0020]/g, '');
  const amount = Number(fracPart ? `${digitsOnly}.${fracPart}` : digitsOnly);

  if (!Number.isFinite(amount)) return fail('NO_NUMBER', `"${token}" did not parse to a finite number`);
  if (amount <= 0) return fail('NON_POSITIVE', `parsed ${amount}`);
  if (amount > settings.maxPlausiblePrice) return fail('OUT_OF_RANGE', `parsed ${amount}, above the sanity ceiling`);

  return {
    ok: true,
    value: {
      amount,
      currency: currencies[0] ?? null,
      detectedFormat: formatHint(rawText, text),
      rawText,
      normalizedText: text,
    },
  };
}

// ───────────────────────────── stock ─────────────────────────────

export type StockReason = 'MATCHED_IN' | 'MATCHED_OUT' | 'EMPTY' | 'CONFLICT' | 'UNRECOGNIZED';

export interface StockParseResult {
  status: StockStatus;
  reason: StockReason;
  /** Units left, when the wording carries a number. Informational only — never gates the status. */
  quantity: number | null;
  /** Which pattern matched, for scrape_logs. */
  matched: string | null;
  rawText: string;
}

/**
 * The five in-stock wordings the storefront rotates through (bundle: `Rr`), plus a few generic
 * fallbacks. The five exact ones are listed first so `matched` names the real template.
 */
const IN_STOCK_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['ine:in-stock-left', /^in stock\s*·\s*(\d+)\s*left$/i],
  ['ine:only-n-left', /^only\s+(\d+)\s+left$/i],
  ['ine:n-in-stock', /^(\d+)\s+in stock$/i],
  ['ine:selling-fast', /^selling fast\s*[—–-]\s*(\d+)\s*left$/i],
  ['ine:hurry-just', /^hurry,\s*just\s+(\d+)\s*left$/i],
  ['generic:in-stock', /\bin stock\b/i],
  ['generic:available', /\b(?:available|in\s+stock\s+now)\b/i],
];

const OUT_OF_STOCK_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['ine:out-of-stock', /^out of stock$/i],
  ['generic:out-of-stock', /\bout of stock\b/i],
  ['generic:sold-out', /\bsold out\b/i],
  ['generic:unavailable', /\b(?:unavailable|currently unavailable)\b/i],
];

/**
 * Missing or unrecognised text is UNKNOWN — never OUT_OF_STOCK. UNKNOWN fails the scrape,
 * which is the whole point: "no stock element" must not be recorded as "this went out of stock".
 */
export function parseStock(raw: string | null | undefined): StockParseResult {
  const rawText = raw ?? '';
  const text = normalizeDigits(stripInvisible(rawText)).replace(FORMATTING_SPACES, ' ').replace(/\s{2,}/g, ' ').trim();

  if (!text) return { status: 'UNKNOWN', reason: 'EMPTY', quantity: null, matched: null, rawText };

  const inMatch = IN_STOCK_PATTERNS.find(([, pattern]) => pattern.test(text));
  const outMatch = OUT_OF_STOCK_PATTERNS.find(([, pattern]) => pattern.test(text));

  if (inMatch && outMatch) {
    return { status: 'UNKNOWN', reason: 'CONFLICT', quantity: null, matched: `${inMatch[0]}+${outMatch[0]}`, rawText };
  }
  if (outMatch) {
    return { status: 'OUT_OF_STOCK', reason: 'MATCHED_OUT', quantity: null, matched: outMatch[0], rawText };
  }
  if (inMatch) {
    const captured = text.match(inMatch[1])?.[1];
    const quantity = captured ? Number(captured) : null;
    // "In stock · 0 left" would be self-contradictory; refuse to guess.
    if (quantity !== null && quantity <= 0) {
      return { status: 'UNKNOWN', reason: 'CONFLICT', quantity, matched: inMatch[0], rawText };
    }
    return { status: 'IN_STOCK', reason: 'MATCHED_IN', quantity, matched: inMatch[0], rawText };
  }

  return { status: 'UNKNOWN', reason: 'UNRECOGNIZED', quantity: null, matched: null, rawText };
}

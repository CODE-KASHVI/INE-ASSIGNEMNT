/**
 * The bridge between "what the page looked like" and "what we believe".
 *
 * Deliberately split in two so the interesting half needs no browser:
 *   · reveal.ts collects a `PriceBlockReading` — a plain, serialisable snapshot of the DOM.
 *   · interpretReading() below turns that snapshot into a RawExtraction, or explains why not.
 *
 * Every trap the storefront sets is handled here, and each has a test in tests/extract.test.ts.
 */
import { parsePrice, parseStock } from './parser';
import { describeExtraction } from './selectors';
import type { StoreLayout } from './selectors';
import { ScrapeError } from './types';
import type { RawExtraction } from './validators';

/** Phases of the price widget, taken from the class on `.price-block`. */
export type PricePhase = 'idle' | 'loading' | 'retrying' | 'success' | 'error' | 'absent';

/**
 * A snapshot of the price widget. Produced inside page.evaluate(), so it must stay plain JSON.
 * Text fields are `textContent` — never `innerText` — because innerText collapses the
 * zero-width separators the `split` carrier relies on and would hide the problem.
 */
export interface PriceBlockReading {
  phase: PricePhase;
  /** h1 — our "the SPA actually rendered a product" gate. */
  titleText: string | null;
  /** "Price hidden" / "Loading current price…" / "Couldn't load the price after N attempts." */
  statusText: string | null;
  substatusText: string | null;
  /** textContent of the element matched by layoutSelectors.priceValue. */
  priceText: string | null;
  /** How many elements matched the price selector. Anything but 1 is a red flag. */
  priceMatchCount: number;
  /** false ⇒ the element exists but is hidden, which is what decoys look like. */
  priceVisible: boolean;
  /** Struck-through list price and "N% off" badge, used for the plausibility check. */
  mrpText: string | null;
  badgeText: string | null;
  /** The storefront renders "Updating…" and dims the price when the quote is stale. */
  pending: boolean;
  /** textContent of `.stock-badge` inside the layout's stock container. */
  stockText: string | null;
  /** 'in-stock' | 'out-stock' | null, from the badge's own class. */
  stockBadgeKind: string | null;
  /** Which of DECOY_SELECTORS were found VISIBLE. Must always be empty. */
  visibleDecoys: string[];
}

export interface InterpretOptions {
  /**
   * How far the revealed price may sit from `mrp * (1 - badgePct/100)` before the reading is
   * rejected. badgePct is an integer, so rounding alone can shift the expected value by up to
   * ~0.5%; 5% leaves generous headroom while still catching a decoy (decoys are the real price
   * scaled by a random 0.6–1.3 factor).
   */
  consistencyTolerance?: number;
  /** Set false to downgrade the plausibility check to a diagnostic. Default true. */
  enforceConsistency?: boolean;
}

const DEFAULTS = { consistencyTolerance: 0.05, enforceConsistency: true } as const;

/** Short, sanitised text for diagnostics. Never store page HTML. */
const snippet = (text: string | null | undefined, max = 120): string | null =>
  text == null ? null : text.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Turns a DOM snapshot into a RawExtraction, or throws a ScrapeError explaining what is wrong.
 * Throwing (rather than returning a partial result) is deliberate: there is no code path here
 * that produces a half-trusted price.
 */
export function interpretReading(reading: PriceBlockReading, layout: StoreLayout, options: InterpretOptions = {}): RawExtraction {
  const settings = { ...DEFAULTS, ...options };
  const diagnosticsBase = {
    phase: reading.phase,
    status: snippet(reading.statusText),
    substatus: snippet(reading.substatusText),
    layoutRevision: layout.revision,
  };

  // 1. The decoy tripwire. If a hidden fake price ever becomes visible, something we do not
  //    understand changed; refuse to read anything from this page.
  if (reading.visibleDecoys.length > 0) {
    throw new ScrapeError('STRUCTURE_CHANGED', `Decoy price element(s) became visible: ${reading.visibleDecoys.join(', ')}`, {
      diagnostics: { ...diagnosticsBase, visibleDecoys: reading.visibleDecoys },
    });
  }

  // 2. Did the SPA render at all? No title ⇒ blank shell / soft-404 / not yet hydrated.
  //    (The store returns HTTP 200 for unknown paths, so status codes cannot answer this.)
  if (!reading.titleText?.trim()) {
    throw new ScrapeError('CONTENT_NOT_READY', 'Product page rendered no <h1> (empty shell, soft-404, or still hydrating)', {
      diagnostics: diagnosticsBase,
    });
  }

  // 3. Phase gating. Only `success` may be read.
  if (reading.phase === 'error') {
    throw new ScrapeError('CONTENT_NOT_READY', `Storefront gave up revealing the price: ${snippet(reading.substatusText) ?? 'unknown reason'}`, {
      diagnostics: diagnosticsBase,
    });
  }
  if (reading.phase !== 'success') {
    throw new ScrapeError('CONTENT_NOT_READY', `Price widget never left the "${reading.phase}" phase`, { diagnostics: diagnosticsBase });
  }

  // 4. The quote is flagged stale by the store itself. A "probably right" price is not a price.
  if (reading.pending) {
    throw new ScrapeError('VALIDATION', 'Storefront marked the quote as pending ("Updating…"); refusing to record a stale price', {
      diagnostics: diagnosticsBase,
    });
  }

  // 5. Did the layout-derived selector actually find the price element?
  if (reading.priceMatchCount === 0) {
    throw new ScrapeError('STRUCTURE_CHANGED', 'Price block is in the success phase but the layout price class matched nothing', {
      diagnostics: { ...diagnosticsBase, layoutPriceClass: layout.classes.priceValue },
    });
  }
  if (reading.priceMatchCount > 1) {
    throw new ScrapeError('STRUCTURE_CHANGED', `Layout price class matched ${reading.priceMatchCount} elements; cannot tell which is the price`, {
      diagnostics: { ...diagnosticsBase, layoutPriceClass: layout.classes.priceValue },
    });
  }
  if (!reading.priceVisible) {
    throw new ScrapeError('STRUCTURE_CHANGED', 'The layout price element is hidden — it behaves like a decoy, not a price', {
      diagnostics: { ...diagnosticsBase, priceText: snippet(reading.priceText) },
    });
  }

  // 6. Plausibility: the selling price must not exceed the struck-through list price, and it
  //    must agree with the discount badge. This is the belt to the visibility braces — it is
  //    what makes swapping in a decoy value detectable rather than merely unlikely.
  const price = parsePrice(reading.priceText);
  if (price.ok) {
    const mrp = parsePrice(reading.mrpText);
    const badgePct = parseBadgePercent(reading.badgeText);

    if (mrp.ok && price.value.amount > mrp.value.amount) {
      throw new ScrapeError('VALIDATION', `Selling price ${price.value.amount} exceeds list price ${mrp.value.amount}`, {
        diagnostics: { ...diagnosticsBase, price: price.value.amount, mrp: mrp.value.amount },
      });
    }

    if (mrp.ok && badgePct !== null && badgePct > 0 && badgePct < 100) {
      const expected = mrp.value.amount * (1 - badgePct / 100);
      const drift = expected === 0 ? 1 : Math.abs(price.value.amount - expected) / expected;
      if (drift > settings.consistencyTolerance) {
        const detail = `price ${price.value.amount} is ${(drift * 100).toFixed(1)}% away from mrp ${mrp.value.amount} less ${badgePct}%`;
        if (settings.enforceConsistency) {
          throw new ScrapeError('VALIDATION', `Revealed price is inconsistent with the discount badge (${detail})`, {
            diagnostics: { ...diagnosticsBase, price: price.value.amount, mrp: mrp.value.amount, badgePct, expected },
          });
        }
      }
    }
  }

  // 7. Stock. The badge's own class is a second, independent signal; if it disagrees with the
  //    wording we do not pick a winner, we fail.
  const stock = parseStock(reading.stockText);
  if (reading.stockBadgeKind === 'in-stock' && stock.status === 'OUT_OF_STOCK') {
    throw new ScrapeError('VALIDATION', 'Stock badge class says in-stock but its wording says out of stock', {
      diagnostics: { ...diagnosticsBase, stockText: snippet(reading.stockText) },
    });
  }
  if (reading.stockBadgeKind === 'out-stock' && stock.status === 'IN_STOCK') {
    throw new ScrapeError('VALIDATION', 'Stock badge class says out-stock but its wording says in stock', {
      diagnostics: { ...diagnosticsBase, stockText: snippet(reading.stockText) },
    });
  }

  const method = describeExtraction(layout, 'price-block');
  return {
    title: reading.titleText.trim(),
    priceText: reading.priceText,
    stockText: reading.stockText,
    priceSource: `${method}/${layout.classes.priceValue}`,
    stockSource: `${method}/${reading.stockBadgeKind ?? 'stock-badge'}`,
  };
}

/** "35% off" → 35. Returns null when the badge is missing or unreadable. */
export function parseBadgePercent(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = text.replace(/\s+/g, ' ').match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

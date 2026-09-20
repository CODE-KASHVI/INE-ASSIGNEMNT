/**
 * THE ONLY PLACE selectors live. Nothing else in the codebase may contain a CSS string.
 *
 * STATUS: VERIFIED against probe-output/report.json (2026-09-20) and the deobfuscated
 * storefront bundle (assets/index-B9UiQq4X.js). See docs/scraper-investigation.md.
 *
 * Two facts drive the whole design:
 *
 *  1. The class that carries the real price is NOT stable. The page renders it as
 *       <priceTag class="{random} {layout.classes.priceValue}">
 *     where `layout` comes from GET /api/layout and rotates (it carries `revision` and
 *     `validUntil`). Hardcoding "pv-z6" would work until the next rotation and then
 *     silently break. So price selectors are BUILT AT RUNTIME from the layout document.
 *
 *  2. The page deliberately renders fake prices under exactly the class names a naive
 *     scraper would reach for. They are `display:none` + `aria-hidden`, and their values
 *     are `shown * random(0.6..1.3)` — plausible, wrong, and stable enough to look real.
 *     They are listed in DECOY_SELECTORS and are never read, only used as a tripwire.
 */

/** The storefront's own JSON endpoints, used for discovery/metadata (never for price). */
export const STORE_ORIGIN = 'https://demo.inelabteamdev.com';

export const API = {
  catalog: (page: number, pageSize: number): string => `${STORE_ORIGIN}/api/catalog?page=${page}&pageSize=${pageSize}`,
  product: (id: number): string => `${STORE_ORIGIN}/api/product/${id}`,
  layout: (): string => `${STORE_ORIGIN}/api/layout`,
  /** The server caps pageSize at 60 regardless of what we ask for (observed). */
  MAX_PAGE_SIZE: 60,
} as const;

export const productPageUrl = (id: number): string => `${STORE_ORIGIN}/product/${id}`;

/**
 * Classes the storefront does NOT rotate — identical across every probe run, and present in
 * the bundle as string literals rather than layout lookups.
 */
export const STABLE = {
  /** Wrapper around the whole price widget, present in every phase. */
  priceBlock: '.price-block',
  /** Phase markers. Exactly one applies to .price-block at any moment. */
  phaseIdle: '.price-block.price-idle',
  phaseSuccess: '.price-block.price-success',
  phaseError: '.price-block.price-error',
  /** Headline + sub-line ("Price hidden", "Retrying (attempt 2/6)…", …). */
  status: '.price-status',
  substatus: '.price-substatus',
  /** The gate button. aria-label is set explicitly in the bundle, so it is safe to target. */
  revealButton: 'button[aria-label="Reveal price"]',
  /** After a failure the same handler is bound to a "Try again" button (no aria-label). */
  retryButton: '.price-block.price-error button.btn-primary',
  /** Row holding mrp / real price / discount badge. */
  priceMain: '.price-main',
  /** Stock pill. `in-stock` carries one of five wordings; `out-stock` is always "Out of stock". */
  stockBadge: '.stock-badge',
  stockIn: '.stock-badge.in-stock',
  stockOut: '.stock-badge.out-stock',
  /** Product title — our "did the page actually render" gate. */
  title: 'h1',
  /**
   * Cookie-consent overlay: a centred modal over a dimmed full-page backdrop with ACCEPT and
   * DECLINE buttons (visible in probe-output/hover-1-page.png; its wrapper class was confirmed
   * by Playwright's own "<div class="cookie-overlay"> intercepts pointer events" log). The probe
   * captured it but never interacted, so it went unnoticed until a live headed run. It renders
   * fresh in every new browser context (no consent cookie survives our per-attempt contexts),
   * so it must be handled on every attempt — and re-checked after any long pause, because it
   * can arrive late.
   */
  cookieOverlay: '.cookie-overlay',
} as const;

/**
 * Hidden elements holding deliberately wrong values. NEVER read these.
 * Kept here so the extractor can assert they stay hidden: if one ever becomes visible, the
 * page changed in a way we do not understand and the scrape must fail loudly.
 */
export const DECOY_SELECTORS: readonly string[] = [
  '.price-value', //       decoy #1: Intl-formatted shown * random(0.6..1.3)
  '[data-price="true"]', // decoy #2: (shown + 7) * random(0.6..1.3)
  '.amount', //            same node as decoy #2
];

/** Keys we require on GET /api/layout. A missing key means the contract changed. */
export const REQUIRED_LAYOUT_CLASS_KEYS = ['priceWrap', 'priceValue', 'mrp', 'badge', 'stock'] as const;
export type LayoutClassKey = (typeof REQUIRED_LAYOUT_CLASS_KEYS)[number];

export interface StoreLayout {
  revision: number;
  variant: number;
  /** Epoch ms after which the class names may rotate. */
  validUntil: number;
  classes: Record<LayoutClassKey, string> & Record<string, string>;
  /** Element name used for the real price, e.g. "span". */
  priceTag: string;
  /** "split" ⇒ the price is rendered one <span> per character, joined by U+200B. */
  priceCarrier: string;
  order?: string[];
}

/** Guards against a hostile/garbled class name being spliced into a selector. */
export function classSelector(name: string): string {
  if (!/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`Refusing to build a selector from an unexpected class name: ${JSON.stringify(name)}`);
  }
  return `.${name}`;
}

/** Same guard for the element name the layout asks us to read the price from. */
export function tagSelector(tag: string): string {
  if (!/^[a-z][a-z0-9-]*$/i.test(tag)) {
    throw new Error(`Refusing to build a selector from an unexpected tag name: ${JSON.stringify(tag)}`);
  }
  return tag.toLowerCase();
}

export interface LayoutSelectors {
  /** The price widget, scoped to this layout revision. */
  priceWrap: string;
  /** The ONLY element the real price may be read from. */
  priceValue: string;
  /** Struck-through list price. Used for the plausibility check, never stored as "price". */
  mrp: string;
  /** "N% off" badge. Also used for the plausibility check. */
  badge: string;
  /** Container for the stock pill. */
  stock: string;
}

/**
 * Turns a layout document into the selectors for this run. Rebuilt whenever the cached layout
 * expires — never baked into a constant.
 */
export function buildLayoutSelectors(layout: StoreLayout): LayoutSelectors {
  const wrap = `${STABLE.priceBlock}${classSelector(layout.classes.priceWrap)}`;
  const main = `${wrap} ${STABLE.priceMain}`;
  return {
    priceWrap: wrap,
    priceValue: `${main} ${tagSelector(layout.priceTag)}${classSelector(layout.classes.priceValue)}`,
    mrp: `${main} ${classSelector(layout.classes.mrp)}`,
    badge: `${main} ${classSelector(layout.classes.badge)}`,
    stock: `${wrap} ${classSelector(layout.classes.stock)}`,
  };
}

/** Human-readable label stored in scrape_logs.extraction_method. */
export function describeExtraction(layout: StoreLayout, strategy: string): string {
  return `layout@r${layout.revision}v${layout.variant}:${strategy}`;
}

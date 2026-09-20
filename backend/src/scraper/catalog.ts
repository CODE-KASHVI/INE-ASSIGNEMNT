/**
 * Product discovery.
 *
 * The storefront's own frontend loads the catalogue from GET /api/catalog and filters in the
 * browser. The probe confirmed the server ignores `q` and `search` (total stays 1000 either
 * way), so server-side search does not exist and we must mirror what the site does.
 *
 * Why this is not scraped through Playwright: the catalogue JSON is the same data the page
 * renders, it is stable (no rotating classes), and searching it costs one cached fetch instead
 * of a browser session per keystroke. The browser is reserved for the one thing that genuinely
 * needs it — the price reveal.
 *
 * Note that catalogue items carry NO price and NO stock. That is a property of the store, not
 * an omission here: price exists only behind the per-product reveal gate. Search results
 * therefore show name/brand/category/SKU, and a price appears once the product is tracked.
 */
import { API, productPageUrl } from './selectors';
import { ScrapeError } from './types';

export interface CatalogItem {
  id: number;
  slug: string;
  name: string;
  brand: string;
  category: string;
  sku: string;
  description: string;
}

export interface SearchHit extends CatalogItem {
  /** Canonical product URL, the value stored in tracked_products.canonical_url. */
  url: string;
  /** Lower is better. Exposed so the API layer can sort or threshold. */
  score: number;
}

export interface CatalogClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** How long a fetched catalogue stays usable. The store's product list is effectively static. */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULTS = { timeoutMs: 15_000, ttlMs: 10 * 60_000 } as const;

interface CatalogPage {
  items: CatalogItem[];
  total: number;
  pages: number;
}

function assertItem(value: unknown): CatalogItem {
  if (typeof value !== 'object' || value === null) throw new ScrapeError('STRUCTURE_CHANGED', 'catalog item is not an object');
  const raw = value as Record<string, unknown>;
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) throw new ScrapeError('STRUCTURE_CHANGED', 'catalog item has no usable numeric id');
  const str = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '');
  const name = str('name');
  if (!name) throw new ScrapeError('STRUCTURE_CHANGED', `catalog item ${id} has no name`);
  return { id, slug: str('slug'), name, brand: str('brand'), category: str('category'), sku: str('sku'), description: str('description') };
}

/** Normalises for matching: case-folded, punctuation-free, single-spaced. */
export function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Scores an item against the query terms. Every term must appear somewhere, which keeps
 * "wireless mouse" from matching every wireless product. Earlier, name-level matches win.
 */
export function scoreItem(item: CatalogItem, terms: readonly string[]): number | null {
  const name = normalizeForSearch(item.name);
  const haystacks = [name, normalizeForSearch(item.brand), normalizeForSearch(item.category), normalizeForSearch(item.sku)];
  let score = 0;

  for (const term of terms) {
    const nameIndex = name.indexOf(term);
    if (nameIndex === 0) {
      score += 0;
    } else if (nameIndex > 0) {
      score += 1;
    } else if (haystacks.some((field) => field.includes(term))) {
      score += 3;
    } else if (normalizeForSearch(item.description).includes(term)) {
      score += 8;
    } else {
      return null; // a term matched nothing at all
    }
  }
  return score + name.length / 1000; // stable tiebreak: shorter names first
}

export class CatalogClient {
  private cache: { items: CatalogItem[]; fetchedAt: number } | null = null;
  private inFlight: Promise<CatalogItem[]> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: CatalogClientOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private async fetchPage(page: number): Promise<CatalogPage> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? DEFAULTS.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(API.catalog(page, API.MAX_PAGE_SIZE), { signal: controller.signal });
      if (!response.ok) {
        throw new ScrapeError('HTTP_STATUS', `/api/catalog page ${page} returned ${response.status}`, { httpStatus: response.status });
      }
      const body = (await response.json()) as Record<string, unknown>;
      const rawItems = body.items;
      if (!Array.isArray(rawItems)) throw new ScrapeError('STRUCTURE_CHANGED', '/api/catalog returned no "items" array');
      return {
        items: rawItems.map(assertItem),
        total: Number(body.total) || 0,
        pages: Number(body.pages) || 1,
      };
    } catch (error) {
      if (error instanceof ScrapeError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ScrapeError('TIMEOUT', `/api/catalog page ${page} timed out after ${timeoutMs}ms`, { cause: error });
      }
      throw new ScrapeError('NETWORK', `/api/catalog page ${page} failed: ${String(error)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Loads every page once, then serves from cache. Concurrent callers share one load. */
  async items(): Promise<CatalogItem[]> {
    const ttl = this.options.ttlMs ?? DEFAULTS.ttlMs;
    if (this.cache && this.now() - this.cache.fetchedAt < ttl) return this.cache.items;
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      const first = await this.fetchPage(1);
      const all = [...first.items];
      for (let page = 2; page <= first.pages; page += 1) {
        const next = await this.fetchPage(page);
        all.push(...next.items);
      }
      // De-duplicate defensively: pagination over a shuffled list can repeat an item.
      const byId = new Map<number, CatalogItem>();
      for (const item of all) byId.set(item.id, item);
      const items = [...byId.values()];
      this.cache = { items, fetchedAt: this.now() };
      return items;
    })();

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  async search(query: string, limit = 20): Promise<SearchHit[]> {
    const terms = normalizeForSearch(query).split(' ').filter(Boolean);
    if (terms.length === 0) return [];

    const items = await this.items();
    const hits: SearchHit[] = [];
    for (const item of items) {
      const score = scoreItem(item, terms);
      if (score !== null) hits.push({ ...item, url: productPageUrl(item.id), score });
    }
    hits.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    return hits.slice(0, limit);
  }

  /** Single-product metadata, used when a product is first tracked. */
  async product(id: number): Promise<CatalogItem> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? DEFAULTS.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(API.product(id), { signal: controller.signal });
      if (response.status === 404) throw new ScrapeError('HTTP_STATUS', `Product ${id} does not exist`, { httpStatus: 404, retryable: false });
      if (!response.ok) throw new ScrapeError('HTTP_STATUS', `/api/product/${id} returned ${response.status}`, { httpStatus: response.status });
      const body = await response.json();
      // The store answers unknown SPA paths with HTML; /api/* returns JSON, so a non-object
      // here means we were served something other than the API.
      return assertItem(body);
    } catch (error) {
      if (error instanceof ScrapeError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ScrapeError('TIMEOUT', `/api/product/${id} timed out after ${timeoutMs}ms`, { cause: error });
      }
      throw new ScrapeError('NETWORK', `/api/product/${id} failed: ${String(error)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

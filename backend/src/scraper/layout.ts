/**
 * Client for GET /api/layout.
 *
 * The storefront rotates the class names that carry the price. The layout document is the
 * authoritative map from role ("priceValue") to the class name in force right now, and it
 * carries `revision` and `validUntil`. Fetching it once per scrape run is what makes the
 * scraper survive a rotation instead of silently reading nothing.
 *
 * A rotation is NORMAL and must not be reported as breakage. A layout that is missing a
 * required key is genuinely a contract change and IS reported as STRUCTURE_CHANGED.
 */
import { API, REQUIRED_LAYOUT_CLASS_KEYS } from './selectors';
import type { StoreLayout } from './selectors';
import { ScrapeError } from './types';

export interface LayoutFetchOptions {
  timeoutMs?: number;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Never trust the shape of a network response. */
export function parseLayout(body: unknown): StoreLayout {
  if (typeof body !== 'object' || body === null) {
    throw new ScrapeError('STRUCTURE_CHANGED', '/api/layout did not return an object');
  }
  const raw = body as Record<string, unknown>;
  const classes = raw.classes;
  if (typeof classes !== 'object' || classes === null) {
    throw new ScrapeError('STRUCTURE_CHANGED', '/api/layout has no "classes" map');
  }
  const classMap = classes as Record<string, unknown>;

  const missing = REQUIRED_LAYOUT_CLASS_KEYS.filter((key) => typeof classMap[key] !== 'string' || !classMap[key]);
  if (missing.length > 0) {
    throw new ScrapeError('STRUCTURE_CHANGED', `/api/layout is missing class keys: ${missing.join(', ')}`, {
      diagnostics: { presentKeys: Object.keys(classMap).slice(0, 20) },
    });
  }

  const priceTag = typeof raw.priceTag === 'string' && raw.priceTag ? raw.priceTag : 'span';
  const priceCarrier = typeof raw.priceCarrier === 'string' ? raw.priceCarrier : 'text';

  return {
    revision: Number(raw.revision) || 0,
    variant: Number(raw.variant) || 0,
    validUntil: Number(raw.validUntil) || 0,
    classes: classMap as StoreLayout['classes'],
    priceTag,
    priceCarrier,
    order: Array.isArray(raw.order) ? (raw.order as string[]) : undefined,
  };
}

export async function fetchLayout(options: LayoutFetchOptions = {}): Promise<StoreLayout> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await doFetch(API.layout(), { signal: controller.signal });
    if (!response.ok) {
      throw new ScrapeError('HTTP_STATUS', `/api/layout returned ${response.status}`, { httpStatus: response.status });
    }
    return parseLayout(await response.json());
  } catch (error) {
    if (error instanceof ScrapeError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ScrapeError('TIMEOUT', `/api/layout timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, { cause: error });
    }
    throw new ScrapeError('NETWORK', `/api/layout request failed: ${String(error)}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Caches the layout until `validUntil` (minus a safety margin). One fetch per run, shared by
 * every product in that run, so a 40-product run does not make 40 identical requests.
 */
export class LayoutCache {
  private cached: StoreLayout | null = null;
  private readonly now: () => number;
  private readonly safetyMarginMs: number;

  constructor(private readonly options: LayoutFetchOptions & { safetyMarginMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.safetyMarginMs = options.safetyMarginMs ?? 60_000;
  }

  private isFresh(layout: StoreLayout): boolean {
    return layout.validUntil > this.now() + this.safetyMarginMs;
  }

  async get(): Promise<StoreLayout> {
    if (this.cached && this.isFresh(this.cached)) return this.cached;
    const layout = await fetchLayout(this.options);
    this.cached = layout;
    return layout;
  }

  /** Called when extraction fails in a way that suggests the cached classes went stale. */
  invalidate(): void {
    this.cached = null;
  }

  peek(): StoreLayout | null {
    return this.cached;
  }
}

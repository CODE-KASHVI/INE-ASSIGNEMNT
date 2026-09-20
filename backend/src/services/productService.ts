/**
 * Glue between HTTP and the repositories/CatalogClient. Never imports `@supabase/supabase-js`
 * directly — everything durable goes through `repositories/`, which is what keeps this file
 * unit-testable without a database (see docs/architecture.md).
 */
import { CatalogClient } from '../scraper/catalog';
import { productPageUrl } from '../scraper/selectors';
import { assertAllowedStoreUrl, canonicalizeProductUrl } from '../utils/url';
import { productRepository } from '../repositories/productRepository';
import { NotFoundError, ValidationFailedError } from '../types/errors';
import type { HealthStatus, ProductDto, SearchHitDto } from '../types/dto';
import { toProductDto, toSearchHitDto } from '../types/dto';
import { scrapeRunner } from './scrapeRunner';

// One client for the process: the catalogue is effectively static (10-minute TTL, see catalog.ts),
// so every search request shares one cached fetch instead of hitting the store per keystroke.
const catalogClient = new CatalogClient();

export interface TrackProductInput {
  storeProductId?: number;
  url?: string;
}

export const productService = {
  async search(query: string, limit: number): Promise<SearchHitDto[]> {
    const hits = await catalogClient.search(query, limit);
    // alreadyTracked is computed per-hit so the frontend can render "Already tracked" without a
    // second round trip (docs/api-design.md). Sequential lookups are fine at this scale (≤50).
    const dtos: SearchHitDto[] = [];
    for (const hit of hits) {
      const existing = await productRepository.findByStoreProductId(hit.id);
      dtos.push(toSearchHitDto(hit, existing !== null));
    }
    return dtos;
  },

  async list(healthFilter: HealthStatus[] | null, sort: 'last_attempt_at_desc' | 'name_asc' | 'price_change_desc'): Promise<ProductDto[]> {
    const rows = await productRepository.list(healthFilter, sort);
    const dtos = rows.map(toProductDto);
    if (sort === 'price_change_desc') {
      dtos.sort((a, b) => (b.priceChange ?? -Infinity) - (a.priceChange ?? -Infinity));
    }
    return dtos;
  },

  async getById(id: string): Promise<ProductDto> {
    const row = await productRepository.findById(id);
    if (!row) throw new NotFoundError(`Tracked product ${id} not found`);
    return toProductDto(row);
  },

  async remove(id: string): Promise<void> {
    await productRepository.delete(id);
  },

  /**
   * Tracks a product, identified by the trusted numeric storeProductId (preferred) or a URL
   * that is validated through the same allow-list the scraper uses. Kicks off an initial scrape
   * fire-and-forget (see docs/api-design.md, POST /api/products) so the dashboard gets a real
   * price within seconds rather than waiting for the next cron tick.
   */
  async track(input: TrackProductInput): Promise<{ dto: ProductDto; initialScrapeQueued: boolean }> {
    let storeProductId: number;

    if (input.storeProductId != null) {
      storeProductId = input.storeProductId;
    } else if (input.url) {
      const url = assertAllowedStoreUrl(input.url); // throws UrlNotAllowedError on any other host
      const match = url.pathname.match(/^\/product\/(\d+)$/);
      if (!match) throw new ValidationFailedError(`Not a recognisable product URL: ${url.pathname}`);
      storeProductId = Number(match[1]);
    } else {
      throw new ValidationFailedError('Provide either "storeProductId" or "url"');
    }

    const meta = await catalogClient.product(storeProductId);
    // Always derived from the trusted storeProductId, never from the caller-supplied `url` —
    // a `url` field is only ever used to *discover* the id above, never persisted verbatim.
    const canonicalUrl = canonicalizeProductUrl(productPageUrl(meta.id));

    const row = await productRepository.create({
      canonicalUrl,
      storeProductId,
      name: meta.name,
      category: meta.category || null,
    });

    // Fire-and-forget: a Playwright reveal takes 3–20+ seconds (see investigation doc's
    // confirmed live timings) and must not hold the HTTP response open that long.
    let initialScrapeQueued = true;
    scrapeRunner.runInitialScrape(row.id).catch(() => {
      // Failures land in scrape_logs via the normal recordFailure path inside runInitialScrape;
      // nothing further to do here except make sure the promise rejection is not unhandled.
    });

    return { dto: toProductDto(row), initialScrapeQueued };
  },
};

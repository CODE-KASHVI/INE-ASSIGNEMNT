/**
 * The only place `scrapeProduct` (Phase 1) gets called from the HTTP layer. Every write to
 * price/stock/logs goes through `productRepository`'s RPC wrappers — this file never inserts a
 * row itself (see docs/architecture.md's "POST /api/scrape/run" trace).
 *
 * NOTE on concurrency: `scraper/productScraper.ts` exports a `scrapeProducts` batch helper, but
 * its `RetryHooks` are shared across the whole batch and carry no per-target identifier —
 * useless for writing a RETRY row against the *right* product. So this file calls
 * `scrapeProduct` once per product through `runWithConcurrency`, with a fresh hooks closure
 * (bound to that product's id and the run id) per call. Same underlying scrape function, same
 * bounded concurrency — just enough extra wiring to keep every attempt attributable.
 */
import { env } from '../config/env';
import { ScraperBrowser } from '../scraper/browser';
import { LayoutCache } from '../scraper/layout';
import { scrapeProduct } from '../scraper/productScraper';
import type { ScrapeTarget } from '../scraper/productScraper';
import type { RetryHooks, RetryOutcome, RetryPolicy } from '../scraper/retry';
import { toScrapeError } from '../scraper/types';
import type { ValidatedSnapshot } from '../scraper/validators';
import { productRepository } from '../repositories/productRepository';
import { runRepository } from '../repositories/runRepository';
import type { TrackedProductRow } from '../types/dto';
import { NotFoundError, ScrapeInProgressError } from '../types/errors';
import { runWithConcurrency } from '../utils/concurrency';

function retryPolicy(): RetryPolicy {
  return { maxAttempts: env.SCRAPER_MAX_RETRIES, delaysMs: [2000, 5000], jitterRatio: 0.2 };
}

function timeouts() {
  return {
    navigationMs: env.SCRAPER_NAVIGATION_TIMEOUT_MS,
    selectorMs: env.SCRAPER_SELECTOR_TIMEOUT_MS,
    revealMs: env.SCRAPER_REVEAL_TIMEOUT_MS,
  };
}

function toTarget(row: TrackedProductRow): ScrapeTarget {
  return { productId: row.id, storeProductId: row.store_product_id, name: row.name };
}

/** Every non-terminal failed attempt becomes a RETRY row via record_retry_attempt(). */
function hooksFor(productId: string, runId: string | null): RetryHooks<ValidatedSnapshot> {
  return {
    onAttemptFailure: async (info) => {
      if (!info.willRetry) return; // the terminal attempt is recorded by persistOutcome, not here
      await productRepository.recordRetry(productId, runId, info);
    },
  };
}

/** Persists one product's final outcome (success or terminal failure) through the RPC wrappers. */
async function persistOutcome(
  productId: string,
  runId: string | null,
  outcome: RetryOutcome<ValidatedSnapshot>,
  durationMs: number,
): Promise<void> {
  if (outcome.ok) {
    await productRepository.recordSuccess(productId, runId, outcome.value, outcome.attempts, durationMs);
  } else {
    await productRepository.recordFailure(productId, runId, outcome.error, outcome.attempts, durationMs);
  }
}

/** One product, start to finish: scrape with per-attempt hooks, then persist the terminal outcome. */
async function scrapeAndPersist(
  deps: { browser: ScraperBrowser; layoutCache: LayoutCache },
  product: TrackedProductRow,
  runId: string | null,
): Promise<RetryOutcome<ValidatedSnapshot>> {
  const target = toTarget(product);
  const startedAt = Date.now();
  const outcome = await scrapeProduct(deps, target, {
    retryPolicy: retryPolicy(),
    timeouts: timeouts(),
    hooks: hooksFor(product.id, runId),
  });
  await persistOutcome(product.id, runId, outcome, Date.now() - startedAt);
  return outcome;
}

export interface CronRunResult {
  skipped: true;
  reason: 'duplicate_trigger';
}

export interface CronRunTallies {
  skipped: false;
  runId: string;
  productsTotal: number;
  productsSuccess: number;
  productsFailed: number;
  productsSkipped: number;
}

export const scrapeRunner = {
  /**
   * The cron/scheduled path: claims a run (absorbing duplicate triggers), locks and scrapes
   * every due product at bounded concurrency, and records tallies on the run itself.
   */
  async runCron(): Promise<CronRunResult | CronRunTallies> {
    const runId = await runRepository.claim('CRON', env.SCRAPE_CRON_DEDUPE_WINDOW_SECONDS, env.SCRAPE_RUN_STALE_SECONDS);
    if (!runId) return { skipped: true, reason: 'duplicate_trigger' };

    const due = await productRepository.getDue(env.SCRAPE_DUE_GRACE_SECONDS);
    const locked: TrackedProductRow[] = [];
    let productsSkipped = 0;
    for (const product of due) {
      // Sequential on purpose: this is a lock-acquisition loop over an already-small "due" list,
      // not the scrape itself — the scrapes below are what run concurrently.
      // eslint-disable-next-line no-await-in-loop
      const gotLock = await productRepository.tryLock(product.id, env.SCRAPE_LOCK_TTL_SECONDS);
      if (gotLock) locked.push(product);
      else productsSkipped += 1; // already locked by an overlapping manual/initial scrape — not force-scraped
    }

    let productsSuccess = 0;
    let productsFailed = 0;

    if (locked.length > 0) {
      const browser = new ScraperBrowser({ headless: env.SCRAPER_HEADLESS });
      const layoutCache = new LayoutCache();
      try {
        const outcomes = await runWithConcurrency(locked, env.SCRAPER_CONCURRENCY, (product) =>
          scrapeAndPersist({ browser, layoutCache }, product, runId),
        );
        for (const outcome of outcomes) {
          if (outcome.ok) productsSuccess += 1;
          else productsFailed += 1;
        }
      } finally {
        await browser.close();
      }
    }

    const tallies = { productsTotal: due.length, productsSuccess, productsFailed, productsSkipped };
    await runRepository.complete(runId, tallies);
    return { skipped: false, runId, ...tallies };
  },

  /**
   * Manual "Scrape Now": one product, synchronous, guarded by the same per-product lock the
   * cron path uses so a click can never race a cron tick on the same product.
   */
  async runManualForProduct(productId: string): Promise<RetryOutcome<ValidatedSnapshot>> {
    const product = await productRepository.findById(productId);
    if (!product) throw new NotFoundError(`Tracked product ${productId} not found`);

    const gotLock = await productRepository.tryLock(product.id, env.SCRAPE_LOCK_TTL_SECONDS);
    if (!gotLock) throw new ScrapeInProgressError();

    const runId = await runRepository.claim('MANUAL', 0, env.SCRAPE_RUN_STALE_SECONDS);
    const browser = new ScraperBrowser({ headless: env.SCRAPER_HEADLESS });
    const layoutCache = new LayoutCache();
    try {
      const outcome = await scrapeAndPersist({ browser, layoutCache }, product, runId);
      if (runId) {
        await runRepository.complete(runId, {
          productsTotal: 1,
          productsSuccess: outcome.ok ? 1 : 0,
          productsFailed: outcome.ok ? 0 : 1,
          productsSkipped: 0,
        });
      }
      return outcome;
    } finally {
      await browser.close();
    }
  },

  /** Fire-and-forget scrape run right after a product is first tracked. Never throws to the caller. */
  async runInitialScrape(productId: string): Promise<void> {
    const product = await productRepository.findById(productId);
    if (!product) return;

    const gotLock = await productRepository.tryLock(product.id, env.SCRAPE_LOCK_TTL_SECONDS);
    if (!gotLock) return;

    const runId = await runRepository.claim('INITIAL', 0, env.SCRAPE_RUN_STALE_SECONDS);
    const browser = new ScraperBrowser({ headless: env.SCRAPER_HEADLESS });
    const layoutCache = new LayoutCache();
    try {
      const outcome = await scrapeAndPersist({ browser, layoutCache }, product, runId);
      if (runId) {
        await runRepository.complete(runId, {
          productsTotal: 1,
          productsSuccess: outcome.ok ? 1 : 0,
          productsFailed: outcome.ok ? 0 : 1,
          productsSkipped: 0,
        });
      }
    } catch (error) {
      // Belt-and-suspenders: scrapeProduct/scrapeAndPersist should never throw for a scrape
      // failure, but a bug here must not crash the fire-and-forget path silently.
      await productRepository.recordFailure(product.id, null, toScrapeError(error), 0, 0).catch(() => undefined);
    } finally {
      await browser.close();
    }
  },
};

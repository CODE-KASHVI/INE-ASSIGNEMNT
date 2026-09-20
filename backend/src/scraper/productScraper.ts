/**
 * Orchestration: layout → page → reveal → interpret → validate → snapshot.
 *
 * The single rule this file exists to enforce: a ValidatedSnapshot is returned ONLY when every
 * stage succeeded. There is no path that returns a partial or "best effort" result, so callers
 * cannot accidentally write one to price_history.
 */
import { LayoutCache } from './layout';
import { interpretReading } from './extract';
import type { InterpretOptions } from './extract';
import { revealPrice, DEFAULT_TIMEOUTS } from './reveal';
import type { RevealEvent, RevealTimeouts } from './reveal';
import { runWithRetry, withDeadline, DEFAULT_RETRY_POLICY } from './retry';
import type { RetryHooks, RetryOutcome, RetryPolicy } from './retry';
import { ScrapeError, toScrapeError } from './types';
import { validateExtraction, validationFailureToScrapeError } from './validators';
import type { ValidatedSnapshot } from './validators';
import type { ScraperBrowser } from './browser';

export interface ScrapeTarget {
  /** Our tracked_products.id. */
  productId: string;
  /** The storefront's numeric product id (the /product/:id segment). */
  storeProductId: number;
  name?: string;
}

export interface ScrapeDeps {
  browser: ScraperBrowser;
  layoutCache: LayoutCache;
}

export interface ScrapeOptions {
  retryPolicy?: RetryPolicy;
  timeouts?: Partial<RevealTimeouts>;
  interpret?: InterpretOptions;
  /** Currency the store is expected to quote in. A mismatch fails the scrape. */
  expectedCurrency?: string | null;
  hooks?: RetryHooks<ValidatedSnapshot>;
  /** Per-attempt progress, forwarded from the reveal flow. Used by the headed CLI and logs. */
  onEvent?: (event: RevealEvent & { attempt: number }) => void;
}

/**
 * Hard ceiling for one attempt. Playwright's own timeouts cover each step, but a wedged
 * browser can still leave a promise pending forever; this guarantees the run moves on.
 * Sized to contain navigation + the two selector waits + the click loop + the app's own
 * handshake on a cold Render instance, so that a slow-but-progressing attempt reaches its own
 * (diagnostic-carrying) error before this generic one fires.
 */
function attemptDeadlineMs(timeouts: RevealTimeouts): number {
  return timeouts.navigationMs + 2 * timeouts.selectorMs + timeouts.revealMs + 30_000;
}

/**
 * Scrapes one product. Never throws for scrape failures — it returns a RetryOutcome so the
 * caller always has something structured to persist, success or not.
 */
export async function scrapeProduct(deps: ScrapeDeps, target: ScrapeTarget, options: ScrapeOptions = {}): Promise<RetryOutcome<ValidatedSnapshot>> {
  const timeouts: RevealTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;

  return runWithRetry<ValidatedSnapshot>(
    async (attempt) => {
      // Fetched once per run and shared; only re-fetched when it expires or we invalidate it.
      const layout = await deps.layoutCache.get();

      const work = deps.browser.withPage(async (page) => {
        const reading = await revealPrice(page, target.storeProductId, layout, {
          timeouts,
          onEvent: options.onEvent ? (event) => options.onEvent?.({ ...event, attempt }) : undefined,
        });

        // Pure from here on: no browser state is consulted again.
        const raw = interpretReading(reading, layout, options.interpret);
        const validation = validateExtraction(raw, { expectedCurrency: options.expectedCurrency ?? 'INR' });
        if (!validation.ok) throw validationFailureToScrapeError(validation, raw);
        return validation.value;
      });

      try {
        return await withDeadline(work, attemptDeadlineMs(timeouts), `scrape of product ${target.storeProductId}`);
      } catch (error) {
        const scrapeError = toScrapeError(error);
        // A STRUCTURE_CHANGED usually means the class names rotated under us. Drop the cached
        // layout so the next attempt re-reads /api/layout rather than repeating the mistake.
        if (scrapeError.type === 'STRUCTURE_CHANGED') deps.layoutCache.invalidate();
        throw scrapeError;
      }
    },
    policy,
    options.hooks ?? {},
  );
}

export interface BatchResult {
  target: ScrapeTarget;
  outcome: RetryOutcome<ValidatedSnapshot>;
}

export interface BatchOptions extends ScrapeOptions {
  /** Pages open at once. 2–3 is what Render's 512MB tolerates alongside Node itself. */
  concurrency?: number;
  /** Called as each product finishes, so results can be persisted while the batch continues. */
  onProductFinished?: (result: BatchResult) => void | Promise<void>;
}

/**
 * Scrapes many products with bounded concurrency. Workers pull from a shared cursor rather
 * than being handed fixed slices, so one slow product cannot leave other workers idle.
 * A thrown error inside one product never aborts the batch.
 */
export async function scrapeProducts(deps: ScrapeDeps, targets: readonly ScrapeTarget[], options: BatchOptions = {}): Promise<BatchResult[]> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, targets.length || 1));
  const results: BatchResult[] = new Array(targets.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) return;
      const target = targets[index] as ScrapeTarget;

      let outcome: RetryOutcome<ValidatedSnapshot>;
      try {
        outcome = await scrapeProduct(deps, target, options);
      } catch (error) {
        // scrapeProduct is not supposed to throw; if it does, it is a bug in our code and the
        // batch must still finish and record it.
        outcome = { ok: false, error: toScrapeError(error), attempts: 0 };
      }

      const result: BatchResult = { target, outcome };
      results[index] = result;
      try {
        await options.onProductFinished?.(result);
      } catch {
        // Persistence failures are the caller's problem to log; they must not stop the batch.
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

export { ScrapeError };

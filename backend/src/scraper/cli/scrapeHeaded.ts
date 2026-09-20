#!/usr/bin/env node
/**
 * Observable scraper run — the assignment's "watch it work" requirement.
 *
 * It calls the SAME scrapeProduct() the cron endpoint calls. Nothing here is a parallel
 * implementation: the only differences are `headless: false`, `slowMo`, and a printer
 * attached to the progress callback the production path already emits.
 *
 *   npm run scrape:headed -- --id 644
 *   npm run scrape:headed -- --url https://demo.inelabteamdev.com/product/644
 *   npm run scrape:headed -- --id 644 --headless        # same run, no window
 *   npm run scrape:headed -- --id 644 --slow 250        # slower, easier to record
 *   npm run scrape:headed -- --id 644 --nav-timeout 400 # force attempt 1 to time out
 *
 * The last form is how you demonstrate retries without touching production code: it only
 * shortens THIS run's navigation timeout, so attempt 1 fails with TIMEOUT, attempt 2 waits
 * ~2s, attempt 3 waits ~5s, and every attempt prints. Note that you often will not need it —
 * the storefront swallows roughly one reveal click in six on its own, which shows up here as
 * a `click_swallowed` line followed by a successful re-click.
 */
import { ScraperBrowser } from '../browser';
import { LayoutCache } from '../layout';
import { scrapeProduct } from '../productScraper';
import { assertAllowedStoreUrl } from '../../utils/url';

interface Args {
  storeProductId: number;
  headless: boolean;
  slowMoMs: number;
  navTimeoutMs?: number;
  maxAttempts: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const rawUrl = get('--url');
  const rawId = get('--id') ?? (rawUrl ? undefined : argv.find((a) => /^\d+$/.test(a)));

  let storeProductId: number | undefined;
  if (rawUrl) {
    // Same allow-list the API uses — the CLI is not a way around SSRF protection.
    const url = assertAllowedStoreUrl(rawUrl);
    const match = url.pathname.match(/^\/product\/(\d+)$/);
    if (!match) throw new Error(`Not a product URL: ${url.pathname}`);
    storeProductId = Number(match[1]);
  } else if (rawId) {
    storeProductId = Number(rawId);
  }

  if (!storeProductId || !Number.isInteger(storeProductId) || storeProductId <= 0) {
    throw new Error('Usage: npm run scrape:headed -- --id <storeProductId> | --url <product url>');
  }

  return {
    storeProductId,
    headless: argv.includes('--headless'),
    slowMoMs: Number(get('--slow') ?? 200),
    navTimeoutMs: get('--nav-timeout') ? Number(get('--nav-timeout')) : undefined,
    maxAttempts: Number(get('--attempts') ?? 3),
  };
}

/** One structured line per event — the same shape the server logs. */
const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  log('run_start', { storeProductId: args.storeProductId, headless: args.headless, slowMoMs: args.slowMoMs });

  const browser = new ScraperBrowser({ headless: args.headless, slowMoMs: args.headless ? 0 : args.slowMoMs });
  const layoutCache = new LayoutCache();

  try {
    const layout = await layoutCache.get();
    log('layout', { revision: layout.revision, variant: layout.variant, priceClass: layout.classes.priceValue, carrier: layout.priceCarrier });

    const outcome = await scrapeProduct(
      { browser, layoutCache },
      { productId: 'cli', storeProductId: args.storeProductId },
      {
        retryPolicy: { maxAttempts: args.maxAttempts, delaysMs: [2000, 5000], jitterRatio: 0.2 },
        timeouts: args.navTimeoutMs ? { navigationMs: args.navTimeoutMs } : undefined,
        onEvent: ({ attempt, ...event }) => log(`reveal.${event.type}`, { attempt, ...event }),
        hooks: {
          onAttemptSuccess: ({ attempt, value, durationMs }) =>
            log('attempt_success', { attempt, durationMs, price: value.price, stock: value.stockStatus, rawPrice: value.rawPriceText }),
          onAttemptFailure: ({ attempt, maxAttempts, error, durationMs, willRetry, nextDelayMs }) =>
            log('attempt_failure', { attempt, maxAttempts, durationMs, errorType: error.type, message: error.message, diagnostics: error.diagnostics, willRetry, nextDelayMs }),
        },
      },
    );

    if (outcome.ok) {
      log('run_success', { attempts: outcome.attempts, ...outcome.value });
      // This is the line that matters: a snapshot only exists because every stage passed.
      console.log(`\n✓ ${outcome.value.rawPriceText} → ${outcome.value.price} ${outcome.value.currency ?? ''} · ${outcome.value.stockStatus}`);
    } else {
      log('run_failed', { attempts: outcome.attempts, errorType: outcome.error.type, message: outcome.error.message, diagnostics: outcome.error.diagnostics });
      console.log('\n✗ No snapshot recorded. The previous known-good price is left untouched.');
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  log('run_crashed', { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});

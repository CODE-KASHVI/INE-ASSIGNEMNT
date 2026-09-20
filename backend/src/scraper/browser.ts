/**
 * Browser lifecycle.
 *
 * One Chromium process for the whole run, one BrowserContext per product (so cookies, the
 * hover gate's state and any per-page JS are isolated), and cleanup in `finally` on every
 * path. Render's free tier gives us ~512MB, so images, fonts and media are blocked — the
 * price is text, and the tiles' <img> tags cost more than everything else combined.
 */
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

export interface BrowserOptions {
  headless: boolean;
  /** Milliseconds of artificial delay between Playwright actions. Demo/debug only. */
  slowMoMs?: number;
  /** Extra Chromium flags. The defaults below are what Render's container needs. */
  args?: string[];
}

/** Flags that matter on a small container: no /dev/shm, no sandbox, no GPU. */
const CONTAINER_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions'];

/** Resource types we never need and always pay for. */
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media']);

export class ScraperBrowser {
  private browser: Browser | null = null;

  constructor(private readonly options: BrowserOptions) {}

  private async ensure(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await chromium.launch({
      headless: this.options.headless,
      slowMo: this.options.slowMoMs ?? 0,
      args: [...CONTAINER_ARGS, ...(this.options.args ?? [])],
    });
    return this.browser;
  }

  /**
   * Runs `work` with a fresh context+page and tears both down afterwards, even if `work`
   * throws or the page hangs. Nothing else in the codebase may create a page.
   */
  async withPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
    const browser = await this.ensure();
    let context: BrowserContext | null = null;
    try {
      context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        // The hover gate and the reveal handler both read real pointer events; a normal
        // desktop UA keeps us on the same code path a human would take.
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 INEPriceTracker/1.0 (assignment scraper)',
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
      });
      await context.route('**/*', (route) => {
        if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) return route.abort();
        return route.continue();
      });
      const page = await context.newPage();
      return await work(page);
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => undefined);
  }
}

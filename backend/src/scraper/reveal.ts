/// <reference lib="dom" />
// The page.evaluate() callbacks below run INSIDE the browser, so this file — and only this
// file — needs the DOM lib. Server code elsewhere deliberately does not see `document`.

/**
 * Drives the storefront's price reveal and returns a plain snapshot of the result.
 * All interpretation lives in extract.ts; this file is only "make the price appear".
 *
 * Why it is shaped this way (all of it comes from the bundle, see docs/scraper-investigation.md):
 *
 *  · The price does not exist until a pointer interaction happens. A control run with no hover
 *    never produced one.
 *  · The gate is `{ minMoves: 8, minDwellMs: 600 }` and mousemove events are throttled to one
 *    per 40ms, so at least 8 moves spread over at least 320ms AND 600ms of dwell are required
 *    before the Reveal button is enabled. We aim comfortably past both.
 *  · The click handler is deliberately unreliable:
 *        if (Math.random() < .35) { if (Math.random() < .5) return; setTimeout(fn, 900); }
 *    ~17.5% of clicks are swallowed with no state change at all, and another ~17.5% fire 900ms
 *    late. A scraper that clicks once and waits for a selector reports a phantom timeout on
 *    roughly one page in six. So we wait past the 900ms path, then detect "still idle" and
 *    click again, logging it as a distinct outcome.
 *  · Once the click lands the app runs its own handshake (challenge → quote → token) and
 *    retries it up to 6 times with 300ms×n backoff, surfacing "Retrying (attempt n/6)…". That
 *    is the app working, not a failure, so we wait it out instead of racing it.
 *
 * Every wait in here has an explicit timeout (see setDefaultTimeout in revealPrice). The first
 * live headed runs showed why: an un-timeouted `isDisabled()` on a button that had left the DOM
 * sat for Playwright's 30s default, ignoring our configured budget, and reported nothing about
 * what the page was doing instead. The click loop is therefore phase-driven: it re-reads the
 * widget's phase every round, treats "the button left because the widget moved on" as progress
 * rather than as a hang, and attaches a snapshot of the widget to the error when it gives up.
 */
import type { Page } from 'playwright';
import { buildLayoutSelectors, DECOY_SELECTORS, productPageUrl, STABLE } from './selectors';
import type { StoreLayout } from './selectors';
import { ScrapeError } from './types';
import type { PriceBlockReading } from './extract';

export interface RevealTimeouts {
  /** page.goto */
  navigationMs: number;
  /** waiting for h1 / .price-block to exist */
  selectorMs: number;
  /** ceiling for any single element action (click, isDisabled, wait for the button) */
  actionMs: number;
  /** how long a single click gets to change the phase before we call it swallowed */
  clickAckMs: number;
  /** how long the app's own challenge/quote handshake gets, including its 6 internal retries */
  revealMs: number;
}

export const DEFAULT_TIMEOUTS: RevealTimeouts = {
  navigationMs: 30_000,
  selectorMs: 15_000,
  actionMs: 5_000,
  clickAckMs: 2_500, // > the 900ms delayed path, with headroom
  revealMs: 20_000,
};

export interface RevealOptions {
  timeouts?: Partial<RevealTimeouts>;
  /** Rounds the click loop may run (a swallowed click, a blocker or a missing button each use one). */
  maxClicks?: number;
  /** Structured progress callback — one line per meaningful event. */
  onEvent?: (event: RevealEvent) => void;
}

export type RevealEvent =
  | { type: 'navigated'; url: string; durationMs: number }
  | { type: 'cookie_overlay_dismissed' }
  /** The overlay was found but is still visible after we tried to dismiss it. */
  | { type: 'cookie_overlay_stuck' }
  | { type: 'gate_satisfied'; moves: number; dwellMs: number }
  /** `click` counts clicks within one page load; the scrape attempt number is added by the caller. */
  | { type: 'clicked'; click: number }
  | { type: 'click_swallowed'; click: number; waitedMs: number }
  | { type: 'click_failed'; round: number; reason: string }
  | { type: 'reveal_button_missing'; round: number; phase: string }
  | { type: 'app_retrying'; message: string | null }
  | { type: 'phase'; phase: string };

const MOVE_COUNT = 12; //   gate needs 8
const MOVE_INTERVAL_MS = 55; // gate throttles to one move per 40ms
const DWELL_MS = 900; //    gate needs 600

/**
 * Navigates, satisfies the hover gate, clicks through swallowed clicks, waits for the app's
 * handshake and returns the DOM snapshot. Never interprets it.
 */
export async function revealPrice(
  page: Page,
  storeProductId: number,
  layout: StoreLayout,
  options: RevealOptions = {},
): Promise<PriceBlockReading> {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const maxClicks = options.maxClicks ?? 4;
  const emit = options.onEvent ?? (() => undefined);
  const selectors = buildLayoutSelectors(layout);
  const url = productPageUrl(storeProductId);

  // Playwright's implicit default is 30s and it applies to every call that is not given an
  // explicit timeout. Pin it to our own budget so no call can quietly outlive the config.
  page.setDefaultTimeout(timeouts.selectorMs);

  const startedAt = Date.now();
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeouts.navigationMs });
  emit({ type: 'navigated', url, durationMs: Date.now() - startedAt });

  // The store answers unknown paths with the SPA shell and HTTP 200, so a 2xx proves nothing.
  // A non-2xx, on the other hand, is unambiguous.
  const status = response?.status() ?? 0;
  if (status && status >= 400) {
    throw new ScrapeError('HTTP_STATUS', `Product page returned ${status}`, { httpStatus: status });
  }

  // `domcontentloaded` fires on an empty <div id="root">. Wait for real content instead.
  // networkidle is avoided on purpose: the app polls on a 250ms interval and would never idle.
  await page.waitForSelector(STABLE.title, { state: 'visible', timeout: timeouts.selectorMs });
  await page.waitForSelector(STABLE.priceBlock, { state: 'visible', timeout: timeouts.selectorMs });

  // Every attempt runs in a fresh browser context (see browser.ts), so no cookie survives
  // between attempts and the consent overlay can render again each time. It does not always
  // appear immediately — a single check right here raced it and missed it on a live run — so
  // this polls for a short window rather than checking once, and clickThroughSwallowedClicks
  // checks again immediately before every click as a second line of defence.
  await dismissCookieOverlay(page, emit);

  // Already revealed (e.g. a "Refresh price" flow) — nothing to click.
  if ((await readPhase(page)) !== 'success') {
    await satisfyHoverGate(page, emit);
    await clickThroughSwallowedClicks(page, timeouts, maxClicks, emit);
    await waitForTerminalPhase(page, timeouts.revealMs, emit);
  }

  return readPriceBlock(page, selectors, DECOY_SELECTORS);
}

type OverlayOutcome = 'absent' | 'dismissed' | 'stuck';

/**
 * Dismisses the cookie-consent overlay if present, and reports whether it actually went away.
 *
 * What is observed (probe-output/hover-1-page.png): a centred modal over a dimmed full-page
 * backdrop, wrapper class `.cookie-overlay`, with two buttons labelled ACCEPT and DECLINE. While
 * it is up the backdrop receives the pointer, so it blocks BOTH the Reveal click and, quite
 * possibly, the mouse moves the hover gate counts — which is why callers re-check it after any
 * long pause. It does not always exist the instant the price block does, so this polls briefly
 * rather than checking once.
 *
 * Never throws. Returns 'stuck' (and emits `cookie_overlay_stuck`) if the overlay is still
 * visible afterwards, so the log never claims a dismissal that did not happen.
 */
async function dismissCookieOverlay(page: Page, emit: (event: RevealEvent) => void): Promise<OverlayOutcome> {
  const overlay = page.locator(STABLE.cookieOverlay).first();
  const isUp = async (): Promise<boolean> => (await overlay.count()) > 0 && (await overlay.isVisible().catch(() => false));

  let visible = false;
  for (let waited = 0; waited < 2000; waited += 250) {
    visible = await isUp();
    if (visible) break;
    await page.waitForTimeout(250);
  }
  if (!visible) return 'absent';

  // ACCEPT is the observed button; the rest are fallbacks in case the wording changes.
  const acceptPatterns = [
    'button:has-text("Accept")',
    'button:has-text("Allow")',
    'button:has-text("Agree")',
    'button:has-text("Got it")',
    'button:has-text("OK")',
    '[aria-label*="accept" i]',
    '[aria-label*="close" i]',
    'button:has-text("Decline")', // still removes the modal, which is all we need
    'button',
  ];

  for (const pattern of acceptPatterns) {
    const button = overlay.locator(pattern).first();
    if ((await button.count()) > 0) {
      const clicked = await button.click({ timeout: 2000 }).then(
        () => true,
        () => false,
      );
      if (clicked) break;
    }
  }

  await overlay.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined);

  if (await isUp()) {
    emit({ type: 'cookie_overlay_stuck' });
    return 'stuck';
  }
  emit({ type: 'cookie_overlay_dismissed' });
  return 'dismissed';
}

/**
 * Moves the mouse across the price block the way a pointer actually travels. Playwright's
 * mouse API produces trusted events; a dispatched MouseEvent would be recorded as untrusted
 * (the handler stores `event.isTrusted`), so synthetic events are never used here.
 */
async function satisfyHoverGate(page: Page, emit: (event: RevealEvent) => void): Promise<void> {
  const box = await page.locator(STABLE.priceBlock).first().boundingBox();
  if (!box) throw new ScrapeError('CONTENT_NOT_READY', 'Price block has no layout box to hover over');

  const startedAt = Date.now();
  const centreY = box.y + box.height / 2;
  for (let i = 0; i < MOVE_COUNT; i += 1) {
    const x = box.x + box.width * (0.25 + 0.5 * (i / (MOVE_COUNT - 1)));
    const y = centreY + Math.sin(i) * Math.min(8, box.height / 6);
    await page.mouse.move(x, y);
    await page.waitForTimeout(MOVE_INTERVAL_MS);
  }
  const remaining = DWELL_MS - (Date.now() - startedAt);
  if (remaining > 0) await page.waitForTimeout(remaining);

  emit({ type: 'gate_satisfied', moves: MOVE_COUNT, dwellMs: Date.now() - startedAt });
}

/**
 * Gets the widget out of `idle`, one bounded round at a time.
 *
 * Each round starts by re-reading the phase, because the button leaving the DOM is ambiguous:
 * it is expected if the widget has moved on (loading / retrying / success / error) and a
 * problem if the widget is still idle or has vanished. Only the second case is a failure, and
 * when it is, the error carries a snapshot of what the widget looked like (describeWidget).
 *
 * A round ends in one of: progress (return), a swallowed click (the store's injected
 * flakiness → re-click), or a blocker (missing button, failed click, overlay) → next round,
 * which re-dismisses the overlay and re-checks the gate. Rounds are capped at `maxClicks`, so
 * the worst case is bounded and every step inside a round has its own explicit timeout.
 */
async function clickThroughSwallowedClicks(
  page: Page,
  timeouts: RevealTimeouts,
  maxClicks: number,
  emit: (event: RevealEvent) => void,
): Promise<void> {
  const { actionMs } = timeouts;
  let clicks = 0;
  let missingRounds = 0;

  for (let round = 1; round <= maxClicks; round += 1) {
    const phase = await readPhase(page);
    if (phase !== 'idle' && phase !== 'absent') return; // already moving — let waitForTerminalPhase take over

    // The overlay can (re)appear during the multi-second hover dwell. If it appeared after our
    // hover, its backdrop may have swallowed the moves, so the gate is re-checked below.
    await dismissCookieOverlay(page, emit);

    const button = page.locator(STABLE.revealButton).first();
    const visible = await button.waitFor({ state: 'visible', timeout: actionMs }).then(
      () => true,
      () => false,
    );
    if (!visible) {
      const nowPhase = await readPhase(page);
      if (nowPhase !== 'idle' && nowPhase !== 'absent') return; // the widget moved on while we waited
      missingRounds += 1;
      emit({ type: 'reveal_button_missing', round, phase: nowPhase });
      continue;
    }

    // null ⇒ the button left the DOM between waitFor and here; treat it like "not visible".
    const disabled = await button.isDisabled({ timeout: actionMs }).catch(() => null);
    if (disabled === null) {
      missingRounds += 1;
      emit({ type: 'reveal_button_missing', round, phase: await readPhase(page).catch(() => 'unknown') });
      continue;
    }
    if (disabled) await satisfyHoverGate(page, emit);

    try {
      await button.click({ timeout: actionMs });
    } catch (error) {
      // Typically "<div class=cookie-overlay> intercepts pointer events". The next round will
      // dismiss it again instead of this whole attempt burning its budget on one click.
      emit({ type: 'click_failed', round, reason: firstLine(error) });
      continue;
    }
    clicks += 1;
    emit({ type: 'clicked', click: clicks });

    const waitedFrom = Date.now();
    const moved = await waitForPhaseChange(page, timeouts.clickAckMs);
    if (moved) return;

    emit({ type: 'click_swallowed', click: clicks, waitedMs: Date.now() - waitedFrom });
  }

  const cause = clicks > 0 ? 'clicks_swallowed' : missingRounds > 0 ? 'reveal_button_unavailable' : 'click_blocked';
  throw new ScrapeError('CONTENT_NOT_READY', `Reveal did not start after ${maxClicks} rounds (${cause}; ${clicks} click(s) landed)`, {
    diagnostics: { cause, rounds: maxClicks, clicks, missingRounds, widget: await describeWidget(page) },
  });
}

/** First line of an error message, trimmed — Playwright appends multi-line call logs. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? '').slice(0, 200);
}

/**
 * A small, sanitised description of the price widget for failure diagnostics: phase, the
 * widget's own status text, every button inside it, and whether the consent overlay is up.
 * Text only, hard-capped — never page HTML. Never throws: diagnostics must not mask the error
 * they are describing.
 */
async function describeWidget(page: Page): Promise<Record<string, unknown>> {
  try {
    return await page.evaluate((stable: typeof STABLE) => {
      const clip = (text: string | null | undefined, max = 80): string | null =>
        text == null ? null : text.replace(/\s+/g, ' ').trim().slice(0, max);
      const block = document.querySelector(stable.priceBlock);
      return {
        url: window.location.pathname,
        blockClass: block ? clip(block.className, 120) : null,
        status: clip(document.querySelector(stable.status)?.textContent),
        substatus: clip(document.querySelector(stable.substatus)?.textContent),
        overlayPresent: document.querySelector(stable.cookieOverlay) !== null,
        buttons: Array.from(document.querySelectorAll(`${stable.priceBlock} button`))
          .slice(0, 6)
          .map((button) => ({
            label: button.getAttribute('aria-label'),
            text: clip(button.textContent, 40),
            disabled: (button as HTMLButtonElement).disabled,
            rendered: button.getClientRects().length > 0,
          })),
      };
    }, STABLE);
  } catch (error) {
    return { unavailable: firstLine(error) };
  }
}

/** Resolves true once `.price-block` is no longer in the idle phase. */
async function waitForPhaseChange(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      (idleSelector: string) => !document.querySelector(idleSelector),
      STABLE.phaseIdle,
      { timeout: timeoutMs, polling: 100 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Waits for `success` or `error`, reporting the app's own retry messages as they appear. */
async function waitForTerminalPhase(page: Page, timeoutMs: number, emit: (event: RevealEvent) => void): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastReported: string | null = null;

  while (Date.now() < deadline) {
    const phase = await readPhase(page);
    if (phase === 'success' || phase === 'error') {
      emit({ type: 'phase', phase });
      return;
    }
    if (phase === 'retrying') {
      const message = await page.locator(STABLE.status).first().textContent().catch(() => null);
      if (message && message !== lastReported) {
        lastReported = message;
        emit({ type: 'app_retrying', message });
      }
    }
    await page.waitForTimeout(200);
  }

  throw new ScrapeError('TIMEOUT', `Price widget did not reach a terminal phase within ${timeoutMs}ms`, {
    diagnostics: { lastPhase: await readPhase(page).catch(() => 'unknown') },
  });
}

async function readPhase(page: Page): Promise<string> {
  return page.evaluate((stable: typeof STABLE) => {
    const block = document.querySelector(stable.priceBlock);
    if (!block) return 'absent';
    if (block.classList.contains('price-success')) return 'success';
    if (block.classList.contains('price-error')) return 'error';
    if (block.classList.contains('price-idle')) return 'idle';
    return block.getAttribute('aria-busy') === 'true' ? 'retrying' : 'loading';
  }, STABLE);
}

/**
 * Collects the snapshot. Runs entirely in the page so it is one round trip and one consistent
 * moment in time — reading field by field could straddle a re-render.
 *
 * textContent (not innerText) throughout: innerText silently drops the zero-width separators
 * the `split` carrier inserts, which would hide a format we need to see and parse.
 */
async function readPriceBlock(
  page: Page,
  selectors: ReturnType<typeof buildLayoutSelectors>,
  decoys: readonly string[],
): Promise<PriceBlockReading> {
  return page.evaluate(
    ({ sel, stable, decoySelectors }) => {
      const isVisible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (Number(style.opacity) <= 0.05) return false;
        return element.getClientRects().length > 0;
      };
      const textOf = (selector: string): string | null => {
        const element = document.querySelector(selector);
        return element ? element.textContent : null;
      };

      const block = document.querySelector(stable.priceBlock);
      const phase = !block
        ? 'absent'
        : block.classList.contains('price-success')
          ? 'success'
          : block.classList.contains('price-error')
            ? 'error'
            : block.classList.contains('price-idle')
              ? 'idle'
              : block.getAttribute('aria-busy') === 'true'
                ? 'retrying'
                : 'loading';

      const priceElements = Array.from(document.querySelectorAll(sel.priceValue));
      const priceElement = priceElements[0] ?? null;

      const stockContainer = document.querySelector(sel.stock);
      const stockBadge = stockContainer ? stockContainer.querySelector(stable.stockBadge) : null;
      const stockBadgeKind = stockBadge
        ? stockBadge.classList.contains('in-stock')
          ? 'in-stock'
          : stockBadge.classList.contains('out-stock')
            ? 'out-stock'
            : null
        : null;

      const mainText = document.querySelector(stable.priceMain)?.textContent ?? '';
      const priceOpacity = priceElement ? Number(window.getComputedStyle(priceElement).opacity) : 1;

      return {
        phase,
        titleText: textOf(stable.title),
        statusText: textOf(stable.status),
        substatusText: textOf(stable.substatus),
        priceText: priceElement ? priceElement.textContent : null,
        priceMatchCount: priceElements.length,
        priceVisible: priceElement ? isVisible(priceElement) : false,
        mrpText: textOf(sel.mrp),
        badgeText: textOf(sel.badge),
        // The store dims the price to 45% and appends "Updating…" when the quote is stale.
        pending: /Updating…/.test(mainText) || (priceElement !== null && priceOpacity < 0.6),
        stockText: stockBadge ? stockBadge.textContent : null,
        stockBadgeKind,
        visibleDecoys: decoySelectors.filter((selector: string) =>
          Array.from(document.querySelectorAll(selector)).some((element) => isVisible(element)),
        ),
      };
    },
    { sel: selectors, stable: STABLE, decoySelectors: [...decoys] },
  ) as Promise<PriceBlockReading>;
}

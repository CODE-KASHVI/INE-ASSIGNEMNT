# Design note — scraping reliability, trade-offs, AI-tool corrections

## 1. What the storefront actually does (and why it changes the design)

Investigation (`backend/docs/scraper-investigation.md`) against the live storefront found:

- It's a single-page app — the raw HTML is an empty shell, so this cannot be scraped with plain
  `fetch` + `cheerio`. A headless browser is required, not a stylistic choice.
- There's an undocumented JSON API (`/api/catalog`, `/api/product/:id`) that returns everything
  *except* price and stock. Search/browse is done against that API directly (cheap, no browser
  needed); only the per-product price/stock read needs Playwright.
- Price is hidden behind a "reveal" interaction that requires a genuine, human-like hover (≥8
  mouse moves, ≥600ms dwell) before a button becomes clickable — synthetic `dispatchEvent` clicks
  don't satisfy it, only Playwright's real input simulation does.
- The reveal button silently swallows roughly 1 in 6 clicks, or fires ~900ms late. A scraper that
  clicks once and waits for a selector will see a "timeout" on about a sixth of runs that isn't
  actually a timeout.
- CSS class names for price/stock elements rotate (served from `/api/layout`, with a
  `validUntil`), so hardcoded selectors work until the next rotation and then silently return
  nothing.
- Unknown/removed product paths return HTTP 200 with the same SPA shell as a real page — HTTP
  status is not a usable success signal.

## 2. How reliability is built in

- **Selectors are derived at runtime** from `/api/layout`, cached per run and refreshed on
  `validUntil` or on a detected structure mismatch, instead of hardcoded — see `layout.ts`.
- **The swallowed/late click is treated as expected behavior, not an error**: after a click, the
  scraper waits past the ~900ms late-fire window, checks for "still idle," and re-clicks if
  needed, logging `click_swallowed` so the retry is visible instead of masquerading as a generic
  timeout (`reveal.ts`).
- **Extraction and validation are separate from interaction.** `revealPrice()` only gets the page
  into a state where a reading is possible; `interpretReading()` and `validateExtraction()` then
  decide, from plain data, whether what came back is a real price/stock pair, a placeholder, or
  malformed — so a "successful" click can still correctly produce a `VALIDATION` failure instead
  of writing garbage.
- **Every attempt runs under a hard per-attempt deadline** (`attemptDeadlineMs`) independent of
  the individual Playwright timeouts, so a wedged page can't hang a batch forever.
- **Up to 3 attempts per product per run**, immediate / ~2s / ~5s backoff with ±20% jitter
  (`retry.ts`), and **`scrapeProduct` never throws** — it always returns a structured
  success-or-failure outcome, so the caller (and the scrape log) always has something honest to
  persist, including on bugs in the caller's own code.
- **Bounded concurrency with a shared work-stealing cursor** (`scrapeProducts`), so one slow
  product can't stall the rest of a run, and one product's failure can't abort the batch.
- **A successful write to `price_history` only happens after full validation passes.** There is
  no partial/best-effort snapshot path — a failed attempt writes to `scrape_logs` only, never to
  history, so the price chart can never show a value that wasn't actually confirmed.

## 3. Trade-offs

| Decision | Trade-off accepted |
|---|---|
| Playwright for the price/stock read, plain HTTP for search/catalog | Slower and heavier than pure HTTP scraping, but the reveal gate genuinely requires a real browser; using HTTP everywhere would have been faster to build but simply wouldn't work for price/stock. |
| Do not reverse-engineer the post-click token/quote handshake | Could shave real time off each scrape by replaying the API directly, but that handshake is private, unversioned, and would silently break on any server change while proving nothing about *browser* reliability, which is what's being assessed. Instead the app's own retry UI is treated as a signal (`app_retrying`) and waited out. |
| External cron (cron-job.org) instead of an in-process scheduler | Simpler mental model and no idle CPU cost, but scrape timing is only as reliable as the third-party cron service and the free Render instance's cold-start time — the due-window/grace-period logic exists specifically to absorb that slack rather than requiring exact-to-the-second pings. |
| 3 attempts, capped concurrency (2–3) | Bounded to keep runs fast and to fit Render's free-tier memory with multiple Chromium pages open; a product that fails 3 times in a row is logged as `failed` for that run rather than retried indefinitely. |
| Reject on validation rather than store "best effort" | Guarantees the history table is trustworthy, at the cost of sometimes recording zero data points for a run where the page rendered but returned an implausible/placeholder value. |

## 4. What AI tools got wrong on the first attempt, and how it was corrected

The scraper's data-extraction step (`readPriceBlock` in `reveal.ts`) defines small inner
helper functions — `isVisible()`, `textOf()` — inside the callback passed to Playwright's
`page.evaluate()`. This callback is meant to run entirely inside the browser page's own
JavaScript context, separate from the Node process.

When the backend is run in development via `tsx` (which transpiles TypeScript through esbuild
with function-name preservation enabled), esbuild automatically wraps named functions like
these with a call to an internal `__name()` helper, used to keep `.name` accurate for
debugging. That helper is injected at the top of the compiled module — but Playwright's
`page.evaluate()` only serializes the literal source of the one function passed to it via
`Function.prototype.toString()`. The surrounding module-level `__name` helper doesn't travel
with it, so every real scrape attempt (both from the API's "Scrape now" button and the
`scrape:headed` CLI) failed with `ReferenceError: __name is not defined`, even though the
reveal/hover/click flow itself worked perfectly and the app-side price genuinely loaded.

This surfaced immediately when running the scraper in headed mode as required by the
assignment: the browser would visibly complete the hover-and-reveal interaction, the price
widget would visibly turn to a "success" state, and then the terminal would log a crash
instead of a snapshot. Because the codebase's retry/logging design records every attempt
honestly rather than silently swallowing failures, this was caught immediately rather than
masked as a false "network flakiness" retry.

The fix was to add a one-line defensive shim at the top of each affected `page.evaluate()`
callback:

```ts
var __name = typeof __name !== 'undefined' ? __name : (fn: unknown) => fn;
```

Because `var` hoists to the top of the function body, this runs before any injected
`__name(...)` calls execute, and safely no-ops them (returning the function itself unchanged)
if the real helper isn't present in that execution context — while doing nothing at all in a
production `tsc` build, where esbuild's transform never runs in the first place. This is a
narrow, environment-specific gotcha rather than a logic bug in the scraping strategy itself:
the interaction model (hover gate → swallowed-click retry → terminal-phase wait → validated
read) was correct on the first attempt; only the mechanics of shipping a closure into a
separate JS realm needed a fix.

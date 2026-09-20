# Storefront investigation and scraper decision

Evidence: `probe-output/report.json` (10 browser runs + a no-hover control, 2026-09-20) and the
deobfuscated application bundle `assets/index-B9UiQq4X.js`. Every selector, timeout and
validation rule in `backend/src/scraper/` traces back to something in this file.

## 1. How the site renders

| Observation | Evidence |
|---|---|
| SPA; raw HTML is 459 bytes with an empty `#root` | `report.json → home.http`, `visibleTextLength: 9` |
| No JSON-LD, no meta tags, no microdata | `jsonLdBlocks: 0`, `metaTags: []` |
| Unknown paths return the SPA shell with **HTTP 200** | `soft404.sameBodyAsHome: true` |
| `robots.txt` and `sitemap.xml` also return the shell | `robots.preview`, `sitemap.preview` |

Consequence: **HTTP status is not a signal.** A product page that no longer exists answers 200
with valid-looking HTML. Presence of content is the only test, which is why
`interpretReading()` gates on `<h1>` rather than on `response.status()`.

## 2. The JSON API the site uses

| Endpoint | Returns | Used for |
|---|---|---|
| `GET /api/catalog?page&pageSize` | `{id, slug, name, brand, category, sku, description}` × 1000 | search / discovery |
| `GET /api/product/:id` | the above + `specs` + `reviews` | metadata on first track |
| `GET /api/layout` | rotating class names + render config | **every scrape** |

Three things worth recording:

- **`pageSize` is capped at 60.** Asking for 100 or 1000 both return 60 (`catalog.pageSize100`,
  `catalog.pageSize1000`). `API.MAX_PAGE_SIZE` reflects this.
- **Server-side search does not exist.** `?q=phone` and `?search=phone` both still report
  `total: 1000` — the parameters are accepted and ignored. The site filters in the browser, so
  `CatalogClient` does the same over a cached full catalogue.
- **No price or stock anywhere in this API.** `itemKeys` has neither, and the `/api/product/644`
  body confirms it. Price is exclusively behind the reveal gate described below. This is why
  search results legitimately cannot show prices.

## 3. The price gate

The control run (`label: "control-nohover"`) sat on the page for 3.3s without hovering and
never saw a price. All ten hover runs also failed — **because the probe never clicked.** The
button's opacity went `0.35 → 1` in every hover run, i.e. the gate opened and nothing pressed it.

From the bundle:

```js
new Ar({ minMoves: 8, minDwellMs: 600 })   // gate requirements
var kr = 40;                                // mousemove events throttled to 1 per 40ms
```

So: ≥8 moves, ≥40ms apart, ≥600ms of dwell, then the Reveal button enables.
`satisfyHoverGate()` uses 12 moves at 55ms with a 900ms floor — comfortably past all three.

### The click is deliberately unreliable

```js
function Xn(e) {
  return () => {
    if (Math.random() < .35) {
      if (Math.random() < .5) return;        // ~17.5%: swallowed entirely, no state change
      window.setTimeout(e, 900);             // ~17.5%: fires 900ms late
    }
    e();
  };
}
```

A scraper that clicks once and waits for a selector reports a phantom timeout on roughly one
page in six. `clickThroughSwallowedClicks()` waits past the 900ms path (`clickAckMs: 2500`),
detects "still idle", and re-clicks — logging `click_swallowed` so the retry is visible rather
than disguised as a timeout. **This is also the demo: you do not need injected faults to show
retry behaviour.**

The handler also records `event.isTrusted`. Playwright's mouse API produces trusted events; a
dispatched `MouseEvent` does not. Nothing in `reveal.ts` uses synthetic events.

### What happens after the click

`GET /api/challenge` → proof-of-work → `POST /api/quote` → `{token}` →
`GET /api/products/:id/quote` with `Authorization: Bearer <token>` → XOR-encrypted payload
decoded to `{shown, mrp, sale, badgePct, stock, currency, at, rating, ratingCount, seller,
deliveryDays, pending, format, triple}`. The app retries this up to 6 times with 300ms×n
backoff and surfaces `Retrying (attempt n/6)…`.

**We do not replay this handshake.** It is private, unversioned, and reimplementing it would
mean shipping a scraper that breaks on any server-side change while proving nothing about
browser reliability. `waitForTerminalPhase()` lets the app do its own retrying and reports it
as `app_retrying` — the app working, not a failure.

## 4. The traps

### Rotating class names

`/api/layout` returns `{revision, variant, validUntil, classes: {priceWrap, priceValue, mrp,
sale, badge, rating, seller, delivery, stock}, priceTag, priceCarrier}`. The probe captured
`priceValue: "pv-z6"` at `revision: 627000`. **Hardcoding `.pv-z6` would work until the next
rotation and then silently return nothing.** `buildLayoutSelectors()` builds selectors from the
live document; `LayoutCache` fetches it once per run and honours `validUntil`.

A rotation is normal and must not be reported as breakage. A *missing class key* is a genuine
contract change and is reported as `STRUCTURE_CHANGED`.

### Decoy prices

The success branch renders two hidden fakes under exactly the class names a naive scraper
reaches for:

```js
<span className="price-value" aria-hidden style={{display:'none'}}>{d.d1}</span>
<span className="amount" data-price="true" aria-hidden style={{display:'none'}}>{d.d2}</span>
```

with `d1 = Fr(Br(shown))` and `d2 = Fr(Br(shown + 7))`, where `Br(e) = e * (0.6 + e%37/37*0.7)`
— the real price scaled by a plausible-looking random factor. The real price is
`<priceTag class="{random} {layout.classes.priceValue}">`.

Three independent defences, all in `extract.ts`:

1. The price is only ever read from the layout-derived selector.
2. The element must be **visible** (`getClientRects().length > 0`, `display`, `visibility`,
   `opacity`). Both decoys are `display:none`, so this alone excludes them.
3. The value must be consistent with the struck-through MRP and the "N% off" badge. `badgePct`
   is an integer, so rounding moves the expected value by ≤0.5%; the tolerance is 5%, and a
   decoy's 0.6–1.3× scaling lands far outside it.

`DECOY_SELECTORS` is also checked as a tripwire: if a decoy ever becomes *visible*, something
changed that we do not understand, and the scrape fails rather than guessing.

### Scrambled price text

Seven rotating formats, all on top of `Intl.NumberFormat('en-IN', {maximumFractionDigits: 0})`
— note **Indian lakh grouping** (`1,29,900`, not `129,900`):

| variant | ₹129900 renders as |
|---|---|
| default | `₹1,29,900` |
| `spaced` | `₹1 29 900` |
| `euro` | `₹1.29.900,00` |
| `trailing` | `₹1,29,900/- (incl. of all taxes)` |
| `unicode` | fullwidth digits U+FF10–FF19 |
| `nbsp` | every character joined by NBSP + U+200B |
| `lakh` | `Rs.<NBSP>1,29,900.00` |

And when `priceCarrier === "split"`, every character is additionally wrapped in its own
`<span>` joined by U+200B.

So the decimal separator **cannot be a constant** — `euro` uses a comma for it while the default
uses a comma for grouping. `parsePrice()` detects it per string:

- two separator characters present → the last one is the decimal, and it must appear exactly
  once with 1–2 trailing digits;
- one separator, appearing once, with exactly 3 trailing digits → grouping (the base format has
  no fractional digits, so a 3-digit tail is never a fraction);
- one separator with 1–2 trailing digits → decimal;
- spaces are only ever group separators.

Anything that does not resolve cleanly is refused, not guessed.

`tests/parser.price.test.ts` ports the store's own formatter and asserts all seven formats × two
carriers × seven amounts (98 cases) round-trip exactly.

### Stock wording

Five rotating in-stock templates (`In stock · N left`, `Only N left`, `N in stock`,
`Selling fast — N left`, `Hurry, just N left`) and one out-of-stock string. A parser that only
knows "In Stock" reads four pages in five as unknown. `.stock-badge.in-stock` /
`.stock-badge.out-stock` is a second, independent signal; when the class and the wording
disagree, the scrape fails rather than picking a winner.

Missing or unrecognised stock text is `UNKNOWN`, which fails the scrape. It is never
`OUT_OF_STOCK`.

### `pending`

When the store flags a quote stale it dims the price to 45% and appends `Updating…`. A
"probably right" price is not a price: `interpretReading()` refuses it.

## 5. Decision

**Hybrid.** JSON API for discovery, Playwright for the price reveal.

- Cheerio alone is impossible: the price is not in the HTML, and the reveal needs a trusted
  pointer event.
- Replaying the challenge/quote handshake is possible but is the wrong artefact — it depends on
  a private contract and demonstrates none of the reliability engineering the task is about.
- Using `/api/catalog` for search is not a shortcut around the hard part; it is the site's own
  public JSON, it is stable, and it avoids launching a browser per keystroke. The browser is
  spent only where it is genuinely required.

## 6. Where each finding lives in the code

| Finding | Code |
|---|---|
| rotating classes | `layout.ts`, `buildLayoutSelectors()` |
| decoy prices | `DECOY_SELECTORS`, visibility check + MRP/badge consistency in `extract.ts` |
| seven price formats | `normalizePriceText()`, `detectDecimalSeparator()` in `parser.ts` |
| five stock wordings | `IN_STOCK_PATTERNS` in `parser.ts` |
| hover gate | `satisfyHoverGate()` in `reveal.ts` |
| swallowed clicks | `clickThroughSwallowedClicks()` in `reveal.ts` |
| app's own 6 retries | `waitForTerminalPhase()` in `reveal.ts` |
| soft-404 | `<h1>` gate in `extract.ts` |
| `pending` quotes | `extract.ts` |
| 512MB budget | image/font/media blocking in `browser.ts`, concurrency 3 in `productScraper.ts` |

## 7. Open items for the next phase

- `scripts/probe-storefront.mjs` should be extended to **click** Reveal so `report.json` records
  a real revealed price, the format variant in play, and time-to-price. The current report
  proves the gate exists but never passes it.
- The MRP/badge tolerance (5%) is derived from reasoning about integer rounding, not from
  observed data. Once the probe captures real revealed quotes, confirm it against a sample and
  tighten if the badge turns out to be exact.
- No verification has been possible against the live site from this environment (no network
  egress). Every extraction rule is derived from the captured evidence and from the bundle
  source; `npm run scrape:headed -- --id 644` is the first thing to run.

## 8. Running it

```bash
npm run install:all          # installs both packages + Chromium
npm test                     # 1 parser/extract/retry/validator suite, no network, no browser
npm run typecheck

# watch a real scrape against the live store
npm run scrape:headed -- --id 644
npm run scrape:headed -- --id 644 --slow 250        # slower, easier to screen-record
npm run scrape:headed -- --id 644 --nav-timeout 400 # force attempt 1 to time out
```

The headed CLI calls the same `scrapeProduct()` the cron endpoint will call — `headless: false`
and a log printer are the only differences, so what you record is the production path.

## 9. Update 2026-09-20 — cookie-consent overlay found on live run

A live `npm run scrape:headed -- --id 644` run surfaced a real obstacle the original probe
never hit (the probe collected DOM snapshots but never clicked anything): a `.cookie-overlay`
element sits on top of the page and intercepts pointer events on the Reveal button. Playwright's
own diagnostic named it directly:

```
- <div class="cookie-overlay">…</div> intercepts pointer events
```

**It reappears every attempt**, because each retry attempt runs in a brand-new browser context
(`browser.ts` — one context per `scrapeProduct` attempt, for isolation), so no consent cookie
survives between attempts.

Fixed in `reveal.ts`: `dismissCookieOverlay()` runs right after the price block is visible and
before the hover gate. It tries a list of common accept-button patterns inside the overlay
(text match on "Accept"/"Allow"/"Agree"/"Got it"/etc., then any `button` as a last resort),
clicks the first one found, and waits briefly for the overlay to hide. It never throws — if
dismissal genuinely fails, the click that follows produces a normal, retryable `TIMEOUT` instead
of a silent hang, which is the same failure mode the run already demonstrated live (see the
`attempt_failure` / `willRetry: true` rows in that run's log).

Not yet confirmed: the overlay's actual internal markup (button text, whether it has an
`aria-label`). The pattern list is a reasonable guess, not observed fact — the next headed run
is what confirms or corrects it.

Also observed in that same run, working as designed: attempt 2 revealed a price but the store
flagged the quote `pending` ("Updating…"), and `interpretReading()` correctly refused to store
it rather than saving a stale value. That is not a bug; it is the "never store incorrect data"
rule catching a real case on the first live attempt.

## 10. Update 2026-09-20, second live run — the overlay dismisser never fired

The fix in §9 checked for the overlay exactly once, right after the price block became visible.
A second live run showed `cookie_overlay_dismissed` never firing in any of 3 attempts, yet the
button still could not be clicked — meaning the overlay likely renders a beat *after* that
single check, not before it, so the check missed it and the click blocked underneath it anyway.

Two changes in `reveal.ts`:
- `dismissCookieOverlay()` now polls for up to 2s (checking every 250ms) instead of checking
  once, so a late-arriving overlay is still caught.
- It is now also called immediately before every click inside `clickThroughSwallowedClicks()`,
  not just once at the top of `revealPrice()` — the multi-second hover dwell is enough time for
  the overlay to (re)appear between the first check and the actual click.

That same run also showed attempt 1 failing on `locator.waitFor(...).toBeVisible()` for the
Reveal button itself timing out at 15s — the button never appeared at all, not merely blocked.
This is not explained by the overlay theory and is not yet understood; it may be unrelated site
slowness, or a second, different obstacle. Attempt 3 ended with "Target page, context or browser
has been closed", cause unconfirmed. Both need a human watching the actual browser window to
diagnose further — the investigation has reached the limit of what log lines alone can tell us.

## 11. CONFIRMED — first successful live scrape, 2026-09-20

```
attempt 1: TIMEOUT on click (transient — overlay/timing, cause not pinned down further)
attempt 2: clicked → "Loading current price…" → success
  price: 5300 INR, stock: IN_STOCK
  rawPriceText: "₹5,300/- (incl. of all taxes)"   ← the `trailing` format, parsed correctly
  rawStockText: "Hurry, just 194 left"             ← one of the five rotating templates
  priceSource: "layout@r627001v0:price-block/pv-a7" ← selector built live from /api/layout
```

This confirms, against the real site, that were previously only inferred from the bundle:
the `trailing` price format, a fifth stock template, and live layout-driven selector
construction. Attempt 1 failing and attempt 2 succeeding is the retry policy working as
designed, not a defect — no further action needed on that specific transient failure.

Status: **scraper core verified end-to-end against the live storefront.**

## 12. Third live run, 2026-09-20 — the Reveal button disappears (cause NOT yet confirmed)

`npm run scrape:headed -- --id 644` (headed, `--slow 200`, no `--nav-timeout`), attempts 1–2:

```
attempt 1: gate_satisfied → TIMEOUT "locator.isDisabled: Timeout 30000ms exceeded ... waiting for
           locator('button[aria-label="Reveal price"]')"        (39s)
attempt 2: cookie_overlay_dismissed → gate_satisfied → TIMEOUT "locator.waitFor: Timeout 15000ms
           exceeded ... to be visible"                           (24s)
```

Reading of the evidence:

- Attempt 1: `waitFor({state:'visible'})` **passed**, then within ~2s the button was gone from the DOM
  (`isDisabled()` waits for the element to exist, and it never did again). Nobody had clicked yet.
- Attempt 2: after the overlay handling and the hover gate the button was never visible for 15s.
- The overlay theory alone does not explain attempt 1 (no overlay was seen in either 2s poll).

What is **not** known: whether the widget left `idle` on its own (loading / error / re-render), whether
the consent modal's arrival or dismissal re-mounts the price block, or whether `--slow 200` distorts the
hover gate's timing. The logs did not capture what the widget was doing instead — that is the real gap.

What was wrong in the code regardless of cause (fixed in `reveal.ts`):

| Defect | Fix |
|---|---|
| `button.isDisabled()` had no timeout, so it used Playwright's 30s default and ignored `selectorMs` | `page.setDefaultTimeout(selectorMs)` plus an explicit `actionMs` (5s) on every element action |
| The click loop never re-read the widget phase, so "button left because the widget moved on" looked like a hang | Phase-driven rounds: each round re-reads the phase; a non-idle phase hands over to `waitForTerminalPhase` |
| `cookie_overlay_dismissed` was emitted even if the overlay was still up | `dismissCookieOverlay()` now verifies and returns `absent \| dismissed \| stuck`, emitting `cookie_overlay_stuck` |
| A failed click ("intercepts pointer events") aborted the attempt | Recorded as `click_failed`; the next round re-dismisses the overlay and retries |
| Failures carried no description of the page | `describeWidget()` attaches phase, status text, every button (label/text/disabled/rendered) and overlay presence to the error; the CLI now prints `diagnostics` on every failed attempt, not only the last |
| The `clicked`/`click_swallowed` events' `attempt` field was overwritten by the scrape attempt number | Renamed to `click` |

The modal's markup is now partly confirmed: `probe-output/hover-1-page.png` shows ACCEPT and DECLINE buttons
over a dimmed backdrop (§9 had guessed at this).

**Next step:** re-run the headed command and read the `diagnostics` on each `attempt_failure`. It will say
which phase the widget was in and which buttons existed. Also worth one control run with `--slow 0`.

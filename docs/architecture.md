# Architecture — Phase 2

## Component diagram

```
React (Vercel)
    │  fetch, JSON
    ▼
Express API (Render)
    │                              ┌──────────────────────────┐
    ├── GET  /api/products/search ─┤ CatalogClient             │──▶ demo.inelabteamdev.com
    │                              │   /api/catalog (live, cached 10 min)
    │                              └──────────────────────────┘
    │
    ├── product CRUD, history, logs
    │        │
    │        ▼
    │   Supabase Postgres  (tracked_products, price_history, scrape_logs, scrape_runs)
    │
    └── POST /api/scrape/run  (cron-job.org, Bearer CRON_SECRET)
        POST /api/products/:id/scrape  (manual, from the dashboard)
             │
             ▼
        scrapeProducts() / scrapeProduct()   ◀── already built, Phase 1
             │
             ▼
        Playwright ── hover, click, reveal ──▶ demo.inelabteamdev.com
```

Two independent paths hit the live store: `CatalogClient` (plain `fetch`, for search — no
browser) and the Playwright scraper (for price/stock — the only thing that needs a browser).
Everything else is Postgres.

## Folder structure

The scraper (`src/scraper/*`) already exists from Phase 1 and is untouched here. Phase 4 adds
everything else:

```
backend/
  src/
    config/
      env.ts               # validated environment (throws at boot, not at first request)
      supabase.ts           # one shared client, service_role key, never sent to the frontend
    scraper/                 # ← Phase 1, already built
      selectors.ts  layout.ts  parser.ts  extract.ts  reveal.ts  browser.ts
      productScraper.ts  catalog.ts  retry.ts  types.ts  validators.ts
      cli/scrapeHeaded.ts
    repositories/            # the ONLY files that touch Supabase directly
      productRepository.ts   # tracked_products CRUD, search-result → tracked-product mapping
      historyRepository.ts   # price_history reads
      scrapeLogRepository.ts # scrape_logs reads
      runRepository.ts       # scrape_runs + claim_scrape_run wrapper
    services/                # glue between HTTP and the scraper/repositories
      productService.ts      # track/untrack, "get dashboard row", search passthrough
      scrapeRunner.ts         # runs scrapeProducts() against due/selected products,
                               # writes results back through the repositories via hooks
    controllers/
      product.controller.ts
      scrape.controller.ts
      health.controller.ts
    routes/
      products.routes.ts
      scrape.routes.ts
      health.routes.ts
    middleware/
      errorHandler.ts        # maps thrown errors → { error: { code, message } } + status
      cronAuth.ts             # Bearer CRON_SECRET check, 401 on mismatch/missing
      rateLimit.ts             # per-IP limit on /search and /:id/scrape
      requestId.ts             # attaches a request id, included in error responses and logs
    types/
      dto.ts                  # response shapes shared by controllers (see §3 below)
    utils/
      url.ts                  # ← Phase 1, already built
      asyncHandler.ts          # wraps async controllers so thrown errors reach errorHandler
    app.ts                     # express() + middleware + routes, no app.listen()
    server.ts                  # app.listen(), reads PORT from config/env.ts
  tests/                       # ← Phase 1 suites, plus Phase 4 additions for repositories/routes
```

`repositories/` is the one place SQL/Supabase calls are allowed. `services/` never imports
`@supabase/supabase-js` directly — this is what makes the repository layer swappable and the
services layer unit-testable without a database.

## Request → response flow, two examples

**`GET /api/products/:id/history`** — pure read, no scraper involvement:
`route → controller → historyRepository.listForProduct(id, {limit, before}) → DTO mapping → JSON`

**`POST /api/scrape/run`** — the interesting one:

```
route (cronAuth middleware checks Bearer token first)
  → scrape.controller.runScheduled()
    → runRepository.claim(‘CRON’)              -- DB function; returns null on a duplicate
                                                    cron trigger within the dedupe window
    → if null: respond 200 { skipped: true, reason: 'duplicate_trigger' }  (not an error —
                                                    cron-job.org retrying is expected, not a bug)
    → productRepository.getDue()                -- DB function get_due_products()
    → for each product, productRepository.tryLock(id)  -- per-product TTL lock; a product
                                                    already locked by an overlapping run is
                                                    skipped, not retried or double-scraped
    → scrapeRunner.run(dueAndLockedProducts, runId)
        → scrapeProducts({browser, layoutCache}, targets, {
            concurrency: 3,
            hooks: {
              onAttemptFailure: (info) => info.willRetry
                ? runRepository.recordRetry(productId, runId, info)     -- RPC: record_retry_attempt
                : undefined,                                            -- terminal handled below
            },
            onProductFinished: (result) => result.outcome.ok
              ? productRepository.recordSuccess(result.target.productId, runId, result.outcome)  -- RPC: record_successful_scrape
              : productRepository.recordFailure(result.target.productId, runId, result.outcome), -- RPC: record_failed_scrape
          })
    → runRepository.complete(runId, tallies)
    → respond 200 { runId, tallies }
```

Every write to `price_history` or `scrape_logs` happens inside one of three Postgres functions
(`record_successful_scrape`, `record_retry_attempt`, `record_failed_scrape`) — the Node layer
never runs a raw `INSERT`. That is what makes "a failed scrape can never create a price_history
row" a property of the schema, not a habit the application code has to maintain correctly on
every code path.

## Error → status code mapping

`middleware/errorHandler.ts` is the single place HTTP status codes get decided:

| Thrown as | HTTP status | `error.code` |
|---|---|---|
| `UrlNotAllowedError` (from `utils/url.ts`) | 400 | `URL_NOT_ALLOWED` |
| Zod validation failure | 400 | `VALIDATION_FAILED` |
| product not found (repository returns null) | 404 | `NOT_FOUND` |
| duplicate `canonical_url` / `store_product_id` (Postgres `23505`) | 409 | `ALREADY_TRACKED` |
| missing/invalid `CRON_SECRET` | 401 | `UNAUTHORIZED` |
| rate limit exceeded | 429 | `RATE_LIMITED` |
| `ScrapeError` reaching a controller uncaught (should not happen — `scrapeProduct` never
  throws for scrape failures, only for genuine bugs) | 500 | `INTERNAL` |
| anything else | 500 | `INTERNAL` |

Every error response has the same envelope (§3), so the frontend has exactly one error-shape to
handle regardless of which endpoint failed.

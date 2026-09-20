# API design — Phase 2

All responses are JSON. All error responses share one envelope:

```json
{ "error": { "code": "NOT_FOUND", "message": "Tracked product 3f2b... not found" } }
```

`code` is one of the values in `docs/architecture.md §"Error → status code mapping"`. Never a
raw Postgres or Playwright error message — those are logged server-side and summarised for the
client.

---

## `GET /api/health`

Liveness only — no DB round trip, no store round trip. For Render's health check and a human
hitting the URL to see if the service is up at all.

**200**
```json
{ "status": "ok", "uptimeSeconds": 4821 }
```

---

## `GET /api/products/search?q=phone&limit=20`

Live search against the storefront's own catalogue (`CatalogClient`, cached 10 minutes
server-side). No database involved — this is discovery, not tracking. Also returns
`alreadyTracked` per hit so the "Track" button can render as "Already tracked" without a second
round trip.

| Query param | Required | Notes |
|---|---|---|
| `q` | yes | 1–100 chars after trimming; `400 VALIDATION_FAILED` if empty |
| `limit` | no | default 20, max 50 |

**200**
```json
{
  "query": "phone",
  "results": [
    {
      "storeProductId": 644,
      "name": "Helix Phone X",
      "brand": "Helix",
      "category": "Phones",
      "sku": "HEL-10001",
      "url": "https://demo.inelabteamdev.com/product/644",
      "alreadyTracked": false
    }
  ]
}
```

No `price` or `stock` field on a search hit — deliberate, not an omission. The storefront's
catalogue API has neither (§ investigation doc, Phase 1); price only exists behind the
per-product reveal gate, so showing it here would mean a browser launch per keystroke.

---

## `GET /api/products`

Dashboard listing. Supports the "Healthy / Retrying / Failed / Structure changed" filter chips.

| Query param | Required | Notes |
|---|---|---|
| `health` | no | one of `PENDING,HEALTHY,RETRYING,FAILED,STRUCTURE_CHANGED`, repeatable |
| `sort` | no | `last_attempt_at_desc` (default) \| `name_asc` \| `price_change_desc` |

**200**
```json
{
  "products": [
    {
      "id": "3f2b6e2e-...",
      "storeProductId": 644,
      "name": "Summit Soundbar S",
      "category": "Audio",
      "url": "https://demo.inelabteamdev.com/product/644",
      "imageUrl": null,
      "currentPrice": 5300,
      "previousPrice": 5450,
      "priceChange": -150,
      "priceChangePercent": -2.75,
      "currency": "INR",
      "currentStock": "IN_STOCK",
      "healthStatus": "HEALTHY",
      "consecutiveFailures": 0,
      "lastScrapedAt": "2026-09-20T07:17:37.728Z",
      "lastAttemptAt": "2026-09-20T07:17:37.728Z",
      "lastAttemptStatus": "SUCCESS"
    }
  ]
}
```

`priceChange` / `priceChangePercent` are computed in the DTO mapper from `current_price` /
`previous_price`, not stored — they are derived, not source data.

---

## `POST /api/products`

Track a product. Body identifies it by `storeProductId` (preferred — the trusted, numeric id a
search result returns) or by `url` (validated through `assertAllowedStoreUrl` regardless of
which is given; a `url` on any other host is `400 URL_NOT_ALLOWED`, never silently ignored).

**Request**
```json
{ "storeProductId": 644 }
```
or
```json
{ "url": "https://demo.inelabteamdev.com/product/644" }
```

On accept: fetches `/api/product/:id` for name/brand/category (via `CatalogClient.product`),
inserts `tracked_products`, and **kicks off an initial scrape** (fire-and-forget from the HTTP
response's point of view — see note below) so the dashboard has a first price within seconds
rather than waiting up to 2 hours for the next cron tick.

**201**
```json
{
  "id": "3f2b6e2e-...",
  "storeProductId": 644,
  "name": "Summit Soundbar S",
  "url": "https://demo.inelabteamdev.com/product/644",
  "healthStatus": "PENDING",
  "initialScrapeQueued": true
}
```

**409** — already tracked (unique violation on `canonical_url` or `store_product_id`):
```json
{ "error": { "code": "ALREADY_TRACKED", "message": "This product is already tracked" } }
```

> **Why fire-and-forget, not `await`:** a Playwright reveal takes 3–20+ seconds even on a good
> run (see the confirmed live timings in the investigation doc) and can take three times that
> across retries. Blocking the HTTP response on it would mean a slow client connection holds a
> browser context open for no reason, and would make `POST /api/products` time out under
> Render's request limits on a bad run. The response confirms the product is tracked; the
> dashboard shows `PENDING` until the initial scrape's `onProductFinished` hook writes the real
> values, same as any other scrape. The frontend polls or the client can call
> `POST /:id/scrape` again if they want to watch it happen (§ below).

---

## `GET /api/products/:id`

Single dashboard row, same shape as one item of `GET /api/products`. **404** if the id doesn't
exist (not a 400 — a well-formed UUID that isn't in the table is a "not found", not a "bad
request").

---

## `DELETE /api/products/:id`

Untracks a product. Hard delete; `price_history` and `scrape_logs` cascade (`ON DELETE CASCADE`
in the schema) — there is no "soft delete, keep history around" requirement in scope, and adding
one would mean every read query needs a `WHERE deleted_at IS NULL` it doesn't currently need.

**204** on success. **404** if not tracked.

---

## `GET /api/products/:id/history?limit=200&before=<ISO timestamp>`

Cursor-paginated by `scraped_at`, newest first. `before` is the `scraped_at` of the last row the
client already has — simpler and less bug-prone than offset pagination against a table that
keeps growing.

**200**
```json
{
  "productId": "3f2b6e2e-...",
  "points": [
    { "scrapedAt": "2026-09-20T07:17:37.728Z", "price": 5300, "currency": "INR", "stockStatus": "IN_STOCK" },
    { "scrapedAt": "2026-09-20T05:14:02.113Z", "price": 5450, "currency": "INR", "stockStatus": "IN_STOCK" }
  ],
  "nextBefore": "2026-09-20T05:14:02.113Z"
}
```
`nextBefore` is `null` when there are no more rows — the frontend stops paging on `null`, not on
an empty array (an empty page can legitimately happen mid-range once filters are added later).

---

## `GET /api/products/:id/logs?limit=200&before=<ISO timestamp>`

Same cursor shape, over `scrape_logs`. This is the "Failures must never be hidden" table —
includes `RETRY` and every terminal status, not success only.

**200**
```json
{
  "productId": "3f2b6e2e-...",
  "entries": [
    {
      "createdAt": "2026-09-20T07:17:34.140Z",
      "runId": "8a91...",
      "attempt": 2,
      "status": "SUCCESS",
      "message": "Scrape succeeded",
      "durationMs": 8269,
      "extractedPrice": 5300,
      "extractedStock": "IN_STOCK",
      "extractionMethod": "layout@r627001v0:price-block/pv-a7"
    },
    {
      "createdAt": "2026-09-20T07:17:27.682Z",
      "runId": "8a91...",
      "attempt": 1,
      "status": "TIMEOUT",
      "message": null,
      "errorType": "TIMEOUT",
      "errorMessage": "locator.click: Timeout 15000ms exceeded...",
      "durationMs": 36734
    }
  ],
  "nextBefore": null
}
```
`errorType` / `errorMessage` / `extractedPrice` / `extractedStock` / `extractionMethod` are
omitted (not `null`-filled) when not applicable to that row's status, to keep a `SUCCESS` row
and a `TIMEOUT` row from looking like they're missing half their fields.

---

## `POST /api/products/:id/scrape`

Manual "Scrape Now" button. One product, immediate, synchronous — the dashboard is expected to
show a spinner and wait, unlike the fire-and-forget initial scrape on tracking.

Concurrency guard: uses the same `try_lock_product` the cron path uses. If the product is
already locked (a cron run or another manual click got there first), responds **409** rather
than launching a second browser session against the same product:

```json
{ "error": { "code": "SCRAPE_IN_PROGRESS", "message": "A scrape for this product is already running" } }
```

Rate limit: 1 request per product per 10 seconds per IP (`middleware/rateLimit.ts`), so a
double-click or a stuck spinner retry can't spawn a pile of Playwright contexts.

**200** (the scrape ran; check `outcome` for whether it *succeeded* — a 200 with
`outcome: "FAILED"` is not an HTTP error, it is a successfully-executed, unsuccessful scrape):
```json
{
  "outcome": "SUCCESS",
  "attempts": 2,
  "price": 5300,
  "currency": "INR",
  "stockStatus": "IN_STOCK"
}
```
or
```json
{
  "outcome": "FAILED",
  "attempts": 3,
  "errorType": "TIMEOUT",
  "message": "Price widget did not reach a terminal phase within 20000ms"
}
```

---

## `POST /api/scrape/run`

The cron endpoint. `Authorization: Bearer <CRON_SECRET>` required — **401** on missing or
wrong token, checked by `middleware/cronAuth.ts` before any other work happens (no DB round
trip on an unauthenticated request).

No request body. Scrapes every product `get_due_products()` returns, at concurrency 3.

**200** — normal completion:
```json
{ "runId": "8a91...", "productsTotal": 12, "productsSuccess": 10, "productsFailed": 1, "productsSkipped": 1 }
```

**200** — duplicate trigger absorbed (this is success, not an error — see architecture doc):
```json
{ "skipped": true, "reason": "duplicate_trigger" }
```

`productsSkipped` counts products that were due but already locked by an overlapping run (e.g.
a manual scrape started seconds before the cron tick) — skipped, not force-scraped, so a manual
click and a cron tick can never race on the same product.

---

## Summary table

| Method | Path | Auth | Touches browser |
|---|---|---|---|
| GET | `/api/health` | none | no |
| GET | `/api/products/search` | none | no |
| GET | `/api/products` | none | no |
| POST | `/api/products` | none | yes (fire-and-forget initial scrape) |
| GET | `/api/products/:id` | none | no |
| DELETE | `/api/products/:id` | none | no |
| GET | `/api/products/:id/history` | none | no |
| GET | `/api/products/:id/logs` | none | no |
| POST | `/api/products/:id/scrape` | none (rate-limited) | yes, synchronous |
| POST | `/api/scrape/run` | `Bearer CRON_SECRET` | yes, synchronous, many |

No endpoint accepts a hostname the scraper doesn't already know about — `POST /api/products`'s
`url` field goes through `assertAllowedStoreUrl` before it touches the database, closing the
SSRF path the assignment specifically calls out.

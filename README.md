# INE Price Tracker

Tracks products from INE's mock storefront (`https://demo.inelabteamdev.com/`) on a fixed
schedule, storing price/stock history and a per-attempt scrape log.

- `backend/` — Express + TypeScript API, Playwright scraper, Supabase repositories
- `frontend/` — React + Vite dashboard (search, track, chart history, view scrape log)

## Live links

| | |
|---|---|
| Frontend (Vercel) | https://ine-assignemnt.vercel.app |
| Backend (Render) | https://ine-assignemnt.onrender.com |
| GitHub repo | https://github.com/CODE-KASHVI/INE-ASSIGNEMNT |

## Architecture

```
cron-job.org (every 2h) --Bearer CRON_SECRET--> POST /api/scrape/run (Render)
                                                        |
                                          finds tracked products due for a scrape
                                                        |
                                     Playwright, 2-3 concurrent tabs -> demo.inelabteamdev.com
                                                        |
                                each attempt -> scrape_logs row (success/retried/failed)
                                     each success -> price_history row
                                                        |
                                                   Supabase (Postgres)
                                                        |
                                        React dashboard (Vercel) reads via REST API
```

Full design detail: `backend/docs/architecture.md`, `backend/docs/scraper-investigation.md`,
`backend/docs/api-design.md`. Reliability trade-offs and AI-assistance notes: `DESIGN_NOTE.md`.

## Prerequisites

- Node.js >= 20
- A free Supabase project (Postgres)
- A free Render account (backend) and Vercel account (frontend)
- A free cron-job.org account (scheduler)

## 1. Database (Supabase)

1. Create a new Supabase project.
2. Open the SQL editor and run `backend/supabase/migrations/0001_init.sql`.
3. Copy **Project URL** and the **service_role** (or "secret") key (Settings → API Keys). The
   anon/publishable key will not work — every table has row-level security enabled with no
   public policies, so all access goes through the backend using the secret key.

## 2. Backend (local dev)

```bash
cd backend
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, FRONTEND_URL
npm install
npx playwright install chromium
npm run dev        # http://localhost:5000
```

Run the test suite / typecheck:

```bash
npm test
npm run typecheck
```

Watch a scrape in a real browser window (the assignment's "headed run" requirement):

```bash
npm run scrape:headed -- --id <storeProductId>
# --slow 250          slow the animation down for recording
# --nav-timeout 400   force attempt 1 to time out, so a retry is visible on demand
```

## 3. Backend (deploy to Render)

1. New Web Service → point at this repo, root directory `backend`.
2. Build command: `npm install && npx playwright install chromium && npm run build`
   (note: no `--with-deps` — Render's build environment doesn't allow the privilege escalation
   that flag needs; the base image already has Chromium's required system libraries)
3. Start command: `npm start`
4. Add the environment variables from `.env.example` (real values) in the Render dashboard.
5. Render's free tier sleeps when idle — the app is never expected to run its own always-on
   scheduling loop; cron-job.org wakes it via the endpoint below.

## 4. Frontend (local dev)

```bash
cd frontend
cp .env.example .env
# VITE_API_URL=http://localhost:5000/api
npm install
npm run dev         # http://localhost:5173
```

## 5. Frontend (deploy to Vercel)

1. New Project → root directory `frontend`, framework preset Vite.
2. Environment variable: `VITE_API_URL=https://ine-assignemnt.onrender.com/api`
3. Deploy. Update the backend's `FRONTEND_URL` env var to the resulting Vercel URL and redeploy
   the backend (CORS is locked to a single exact origin, no wildcard).

## 6. Scheduling (cron-job.org)

1. New cron job → URL: `https://ine-assignemnt.onrender.com/api/scrape/run`
2. Method: `POST`
3. Header: `Authorization: Bearer <CRON_SECRET>` (same value as the backend's `CRON_SECRET`)
4. Schedule: every 2 hours (`0 */2 * * *`)

The endpoint itself decides which tracked products are actually due (it is safe to ping it more
often than 2h); the cron-job.org schedule just needs to be at least that frequent so the
service also gets woken from sleep in time.

## Environment variables

### Backend (`backend/.env`)

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only key; bypasses RLS |
| `FRONTEND_URL` | yes | Exact deployed frontend origin, for CORS |
| `CRON_SECRET` | yes | Bearer token cron-job.org must send to `/api/scrape/run` |
| `PORT` | no | default `5000` |
| `SCRAPER_HEADLESS` | no | default `true`; `false` for local headed runs |
| `SCRAPER_MAX_RETRIES` | no | default `3` |
| `SCRAPER_NAVIGATION_TIMEOUT_MS` | no | default `30000` |
| `SCRAPER_SELECTOR_TIMEOUT_MS` | no | default `15000` |
| `SCRAPER_REVEAL_TIMEOUT_MS` | no | default `20000` |
| `SCRAPER_CONCURRENCY` | no | default `3`; open pages at once |
| `SCRAPE_INTERVAL_HOURS_DEFAULT` | no | default `2` |
| `SCRAPE_DUE_GRACE_SECONDS` | no | default `600` |
| `SCRAPE_CRON_DEDUPE_WINDOW_SECONDS` | no | default `3600` |
| `SCRAPE_RUN_STALE_SECONDS` | no | default `900` |
| `SCRAPE_LOCK_TTL_SECONDS` | no | default `300` |

### Frontend (`frontend/.env`)

| Variable | Required | Purpose |
|---|---|---|
| `VITE_API_URL` | yes | Backend API root, e.g. `https://ine-assignemnt.onrender.com/api` |

## Scraping schedule

Every tracked product is scraped **once every 2 hours**, triggered externally by cron-job.org
calling `POST /api/scrape/run` (never an in-process interval, since Render's free tier sleeps).
Each call processes whichever tracked products are currently due, with up to 3 attempts per
product (immediate, then ~2s, then ~5s, each ±20% jitter) before that product is logged as a
failure for the run — see `DESIGN_NOTE.md` for why.

-- =============================================================================
-- INE Price & Stock Tracker — initial schema
--
-- Design goals (in priority order):
--   1. A failed / uncertain scrape can NEVER create a price_history row
--      (enforced by CHECK constraints AND by routing all writes through the
--      record_* functions below, which run in one transaction).
--   2. Duplicate cron triggers / concurrent scrapes cannot create duplicate
--      snapshots (claim_scrape_run + try_lock_product + UNIQUE(product_id, run_id)).
--   3. Every attempt is observable (scrape_logs), including failures.
--
-- Only the backend (service_role key) talks to the database. RLS is enabled with
-- NO policies, so the anon/authenticated roles can read and write nothing.
-- =============================================================================

create extension if not exists pgcrypto;  -- gen_random_uuid() on older PG; harmless otherwise

-- ─────────────────────────────── helpers ───────────────────────────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─────────────────────────────── scrape_runs ───────────────────────────────
-- One row per invocation of the scraper (cron, manual button, initial scrape, CLI).

create table public.scrape_runs (
  id                uuid primary key default gen_random_uuid(),
  trigger_source    text not null check (trigger_source in ('CRON', 'MANUAL', 'INITIAL', 'CLI')),
  status            text not null default 'RUNNING'
                      check (status in ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'ABANDONED')),
  started_at        timestamptz not null default now(),
  completed_at      timestamptz,
  products_total    integer not null default 0 check (products_total >= 0),
  products_success  integer not null default 0 check (products_success >= 0),
  products_failed   integer not null default 0 check (products_failed >= 0),
  products_skipped  integer not null default 0 check (products_skipped >= 0)
);

create index scrape_runs_started_at_idx on public.scrape_runs (started_at desc);
create index scrape_runs_running_idx on public.scrape_runs (started_at) where status = 'RUNNING';

-- ─────────────────────────────── tracked_products ───────────────────────────────

create table public.tracked_products (
  id                   uuid primary key default gen_random_uuid(),

  -- Identity. canonical_url is produced by the backend (canonicalizeProductUrl) from a
  -- trusted search result. store_product_id is the storefront's numeric /product/:id — every
  -- product we can track has one (it is how the scraper navigates), so it is required, not
  -- optional metadata.
  canonical_url        text not null
                          check (canonical_url like 'https://demo.inelabteamdev.com/%'), -- defense in depth; the
                                                                                          -- real allow-list lives in
                                                                                          -- utils/url.ts and runs
                                                                                          -- before this insert
  store_product_id     integer not null check (store_product_id > 0),
  name                 text not null check (btrim(name) <> ''),
  -- The storefront's catalogue has no image field at all (confirmed: /api/catalog and
  -- /api/product/:id item keys never include one). Column kept nullable and unused for now,
  -- in case the store adds one later; the frontend falls back to a category icon instead.
  category             text,
  image_url            text,

  -- Latest KNOWN-GOOD values. These are only ever written by record_successful_scrape().
  currency             text,
  current_price        numeric(12, 2) check (current_price is null or current_price > 0),
  previous_price       numeric(12, 2) check (previous_price is null or previous_price > 0),  -- last DIFFERENT price
  price_changed_at     timestamptz,
  current_stock        text check (current_stock is null or current_stock in ('IN_STOCK', 'OUT_OF_STOCK')),

  -- Scrape bookkeeping
  last_scraped_at      timestamptz,   -- last SUCCESSFUL scrape
  last_attempt_at      timestamptz,   -- last attempt of any outcome (drives "is this product due?")
  last_attempt_status  text check (last_attempt_status is null or last_attempt_status in
                         ('SUCCESS', 'FAILED', 'VALIDATION_FAILED', 'TIMEOUT', 'STRUCTURE_CHANGED')),
  health_status        text not null default 'PENDING'
                         check (health_status in ('PENDING', 'HEALTHY', 'RETRYING', 'FAILED', 'STRUCTURE_CHANGED')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  scrape_interval_hours integer not null default 2 check (scrape_interval_hours between 1 and 168),
  scrape_lock_until    timestamptz,   -- per-product lock with TTL (crash-safe)

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- No-duplicate-tracking guarantees (either identifier collision is rejected).
create unique index tracked_products_canonical_url_uidx on public.tracked_products (canonical_url);
create unique index tracked_products_store_product_id_uidx on public.tracked_products (store_product_id);
create index tracked_products_last_attempt_idx on public.tracked_products (last_attempt_at nulls first);

create trigger tracked_products_set_updated_at
  before update on public.tracked_products
  for each row execute function public.set_updated_at();

-- ─────────────────────────────── price_history ───────────────────────────────
-- Append-only. Only confident, validated snapshots. UNKNOWN stock is impossible here.

create table public.price_history (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references public.tracked_products (id) on delete cascade,
  run_id          uuid references public.scrape_runs (id) on delete set null,
  price           numeric(12, 2) not null check (price > 0),
  currency        text,
  stock_status    text not null check (stock_status in ('IN_STOCK', 'OUT_OF_STOCK')),
  raw_price_text  text,   -- exactly what we parsed, for audits
  raw_stock_text  text,
  scraped_at      timestamptz not null default now(),

  -- Idempotency: one snapshot per product per run, no matter how many times we're triggered.
  constraint price_history_product_run_uniq unique (product_id, run_id)
);

create index price_history_product_time_idx on public.price_history (product_id, scraped_at desc);

-- ─────────────────────────────── scrape_logs ───────────────────────────────
-- One row per ATTEMPT. Failures are first-class citizens and never hidden.

create table public.scrape_logs (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references public.tracked_products (id) on delete cascade,
  run_id            uuid references public.scrape_runs (id) on delete set null,
  attempt_number    integer not null check (attempt_number >= 1),
  status            text not null check (status in
                      ('SUCCESS', 'RETRY', 'FAILED', 'VALIDATION_FAILED', 'TIMEOUT', 'STRUCTURE_CHANGED')),
  will_retry        boolean not null default false,
  message           text,
  error_type        text,
  error_message     text,
  http_status       integer,
  duration_ms       integer check (duration_ms is null or duration_ms >= 0),
  extracted_price   numeric(12, 2),
  extracted_stock   text,
  extraction_method text,   -- which selector / fallback produced the values
  diagnostics       jsonb,   -- sanitized + size-capped in application code (a CHECK here could make a failure log itself fail)
  created_at        timestamptz not null default now()
);

create index scrape_logs_product_time_idx on public.scrape_logs (product_id, created_at desc);
create index scrape_logs_run_idx on public.scrape_logs (run_id);

-- ─────────────────────────────── functions ───────────────────────────────

-- Claim a scrape run. Returns the new run id, or NULL if this is a duplicate trigger.
--   * advisory lock serialises concurrent claims (two cron hits at the same instant)
--   * CRON triggers are deduplicated inside p_dedupe_window_seconds of a RUNNING/COMPLETED/PARTIAL run
--   * runs stuck in RUNNING beyond p_stale_seconds (process crashed / Render restarted) are ABANDONED
create or replace function public.claim_scrape_run(
  p_source text,
  p_dedupe_window_seconds integer default 3600,
  p_stale_seconds integer default 900
)
returns uuid
language plpgsql
as $$
declare
  v_run_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('ine:claim_scrape_run'));

  update public.scrape_runs
     set status = 'ABANDONED', completed_at = now()
   where status = 'RUNNING'
     and started_at < now() - make_interval(secs => p_stale_seconds);

  if p_source = 'CRON' and exists (
    select 1
      from public.scrape_runs
     where trigger_source = 'CRON'
       and status in ('RUNNING', 'COMPLETED', 'PARTIAL')
       and started_at > now() - make_interval(secs => p_dedupe_window_seconds)
  ) then
    return null;
  end if;

  insert into public.scrape_runs (trigger_source) values (p_source) returning id into v_run_id;
  return v_run_id;
end;
$$;

-- Products due for scraping. A small grace period prevents the classic
-- "cron fired 3 seconds early so every other run skips the product" bug.
create or replace function public.get_due_products(
  p_grace_seconds integer default 600,
  p_force boolean default false
)
returns setof public.tracked_products
language sql
stable
as $$
  select *
    from public.tracked_products
   where p_force
      or last_attempt_at is null
      or now() >= last_attempt_at
                  + make_interval(hours => scrape_interval_hours)
                  - make_interval(secs => p_grace_seconds)
   order by last_attempt_at nulls first;
$$;

-- Atomic per-product lock with TTL. Returns true if the caller now owns the lock.
create or replace function public.try_lock_product(p_product_id uuid, p_ttl_seconds integer default 300)
returns boolean
language plpgsql
as $$
declare
  v_id uuid;
begin
  update public.tracked_products
     set scrape_lock_until = now() + make_interval(secs => p_ttl_seconds)
   where id = p_product_id
     and (scrape_lock_until is null or scrape_lock_until < now())
  returning id into v_id;
  return v_id is not null;
end;
$$;

-- THE ONLY WAY a price snapshot is written. One transaction:
--   price_history insert + tracked_products update + success log + lock release.
-- A unique-violation (23505) on (product_id, run_id) rolls everything back → caller treats as duplicate.
create or replace function public.record_successful_scrape(
  p_product_id      uuid,
  p_run_id          uuid,
  p_attempt         integer,
  p_price           numeric,
  p_currency        text,
  p_stock           text,
  p_raw_price_text  text,
  p_raw_stock_text  text,
  p_method          text,
  p_duration_ms     integer
)
returns uuid
language plpgsql
as $$
declare
  v_history_id uuid;
begin
  -- Defence in depth: the table CHECKs would also reject these.
  if p_price is null or p_price <= 0 then
    raise exception 'refusing to record non-positive price %', p_price using errcode = '22023';
  end if;
  if p_stock not in ('IN_STOCK', 'OUT_OF_STOCK') then
    raise exception 'refusing to record stock status %', p_stock using errcode = '22023';
  end if;

  perform 1 from public.tracked_products where id = p_product_id for update;
  if not found then
    raise exception 'tracked product % not found', p_product_id using errcode = 'P0002';
  end if;

  insert into public.price_history
    (product_id, run_id, price, currency, stock_status, raw_price_text, raw_stock_text)
  values
    (p_product_id, p_run_id, p_price, p_currency, p_stock, left(p_raw_price_text, 200), left(p_raw_stock_text, 200))
  returning id into v_history_id;

  update public.tracked_products
     set previous_price   = case when current_price is not null and current_price <> p_price
                                 then current_price else previous_price end,
         price_changed_at = case when current_price is null or current_price <> p_price
                                 then now() else price_changed_at end,
         current_price    = p_price,
         currency         = coalesce(p_currency, currency),
         current_stock    = p_stock,
         last_scraped_at  = now(),
         last_attempt_at  = now(),
         last_attempt_status = 'SUCCESS',
         health_status    = 'HEALTHY',
         consecutive_failures = 0,
         scrape_lock_until = null
   where id = p_product_id;

  insert into public.scrape_logs
    (product_id, run_id, attempt_number, status, will_retry, message,
     http_status, duration_ms, extracted_price, extracted_stock, extraction_method)
  values
    (p_product_id, p_run_id, p_attempt, 'SUCCESS', false, 'Scrape succeeded',
     null, p_duration_ms, p_price, p_stock, p_method);

  return v_history_id;
end;
$$;

-- Logs a non-terminal RETRY attempt and marks the product RETRYING. Deliberately touches
-- NEITHER last_attempt_at NOR consecutive_failures: those describe completed attempts, and a
-- retry-in-progress is not one yet. Called from the retry loop's onAttemptFailure hook whenever
-- willRetry is true; record_successful_scrape / record_failed_scrape handle the terminal row.
create or replace function public.record_retry_attempt(
  p_product_id     uuid,
  p_run_id         uuid,
  p_attempt        integer,
  p_error_type     text,
  p_error_message  text,
  p_http_status    integer,
  p_duration_ms    integer,
  p_next_delay_ms  integer,
  p_diagnostics    jsonb default null
)
returns void
language plpgsql
as $$
begin
  insert into public.scrape_logs
    (product_id, run_id, attempt_number, status, will_retry, message, error_type,
     error_message, http_status, duration_ms, diagnostics)
  values
    (p_product_id, p_run_id, p_attempt, 'RETRY', true,
     case when p_next_delay_ms is null then 'Retrying'
          else format('Retrying in ~%sms', p_next_delay_ms) end,
     p_error_type, left(p_error_message, 1000), p_http_status, p_duration_ms, p_diagnostics);

  update public.tracked_products
     set health_status = 'RETRYING'
   where id = p_product_id;
end;
$$;

-- Terminal failure after retries are exhausted (or a non-retryable error).
-- Touches NO price data: previous known-good price / stock stay exactly as they were.
create or replace function public.record_failed_scrape(
  p_product_id     uuid,
  p_run_id         uuid,
  p_attempt        integer,
  p_status         text,     -- FAILED | VALIDATION_FAILED | TIMEOUT | STRUCTURE_CHANGED
  p_error_type     text,
  p_error_message  text,
  p_http_status    integer,
  p_duration_ms    integer,
  p_diagnostics    jsonb default null
)
returns void
language plpgsql
as $$
begin
  if p_status not in ('FAILED', 'VALIDATION_FAILED', 'TIMEOUT', 'STRUCTURE_CHANGED') then
    raise exception 'invalid terminal failure status %', p_status using errcode = '22023';
  end if;

  insert into public.scrape_logs
    (product_id, run_id, attempt_number, status, will_retry, message, error_type,
     error_message, http_status, duration_ms, diagnostics)
  values
    (p_product_id, p_run_id, p_attempt, p_status, false,
     'Scrape failed; previous known-good values retained',
     p_error_type, left(p_error_message, 1000), p_http_status, p_duration_ms, p_diagnostics);

  update public.tracked_products
     set last_attempt_at = now(),
         last_attempt_status = p_status,
         health_status = case when p_status = 'STRUCTURE_CHANGED' then 'STRUCTURE_CHANGED' else 'FAILED' end,
         consecutive_failures = consecutive_failures + 1,
         scrape_lock_until = null
   where id = p_product_id;
end;
$$;

-- ─────────────────────────────── security ───────────────────────────────

alter table public.scrape_runs       enable row level security;
alter table public.tracked_products  enable row level security;
alter table public.price_history     enable row level security;
alter table public.scrape_logs       enable row level security;
-- (no policies on purpose: only the service_role key, which bypasses RLS, may access data)

revoke all on public.scrape_runs, public.tracked_products, public.price_history, public.scrape_logs
  from anon, authenticated;

revoke all on function public.claim_scrape_run(text, integer, integer)       from public, anon, authenticated;
revoke all on function public.get_due_products(integer, boolean)             from public, anon, authenticated;
revoke all on function public.try_lock_product(uuid, integer)                from public, anon, authenticated;
revoke all on function public.record_successful_scrape(uuid, uuid, integer, numeric, text, text, text, text, text, integer)
                                                                             from public, anon, authenticated;
revoke all on function public.record_retry_attempt(uuid, uuid, integer, text, text, integer, integer, integer, jsonb)
                                                                             from public, anon, authenticated;
revoke all on function public.record_failed_scrape(uuid, uuid, integer, text, text, text, integer, integer, jsonb)
                                                                             from public, anon, authenticated;

grant execute on function public.claim_scrape_run(text, integer, integer)    to service_role;
grant execute on function public.get_due_products(integer, boolean)          to service_role;
grant execute on function public.try_lock_product(uuid, integer)             to service_role;
grant execute on function public.record_successful_scrape(uuid, uuid, integer, numeric, text, text, text, text, text, integer)
                                                                             to service_role;
grant execute on function public.record_retry_attempt(uuid, uuid, integer, text, text, integer, integer, integer, jsonb)
                                                                             to service_role;
grant execute on function public.record_failed_scrape(uuid, uuid, integer, text, text, text, integer, integer, jsonb)
                                                                             to service_role;

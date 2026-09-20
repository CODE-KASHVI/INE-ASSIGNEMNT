/**
 * The only file that reads or writes `tracked_products`. Every write to price/stock happens
 * through one of the three RPCs in supabase/migrations/0001_init.sql
 * (record_successful_scrape / record_retry_attempt / record_failed_scrape) — this file never
 * issues a raw UPDATE to current_price, current_stock, or health_status, so "a failed scrape
 * can never create a price_history row" stays a property of the schema, not application habit.
 */
import { PG_ERROR, supabase } from '../config/supabase';
import { AlreadyTrackedError, NotFoundError } from '../types/errors';
import type { HealthStatus, TrackedProductRow } from '../types/dto';
import type { AttemptFailure } from '../scraper/retry';
import type { ValidatedSnapshot } from '../scraper/validators';
import { terminalStatusFor } from '../scraper/types';
import type { ScrapeError } from '../scraper/types';

export interface CreateProductInput {
  canonicalUrl: string;
  storeProductId: number;
  name: string;
  category: string | null;
}

/** Diagnostics are sanitized short strings already (validators.ts / types.ts) — capped again here defensively. */
function toDiagnosticsJson(error: ScrapeError): Record<string, unknown> | null {
  if (!error.diagnostics) return null;
  return JSON.parse(JSON.stringify(error.diagnostics).slice(0, 4000));
}

export const productRepository = {
  async list(healthFilter: HealthStatus[] | null, sort: 'last_attempt_at_desc' | 'name_asc' | 'price_change_desc'): Promise<TrackedProductRow[]> {
    let query = supabase.from('tracked_products').select('*');
    if (healthFilter && healthFilter.length > 0) query = query.in('health_status', healthFilter);

    if (sort === 'name_asc') {
      query = query.order('name', { ascending: true });
    } else {
      // price_change_desc is computed, not a column — approximate with recency and let the
      // controller sort the derived field if it matters; keeping this simple was a deliberate
      // scope call (see docs/api-design.md, "sort" is a nice-to-have, not core).
      query = query.order('last_attempt_at', { ascending: false, nullsFirst: true });
    }

    const { data, error } = await query;
    if (error) throw error;
    return data as TrackedProductRow[];
  },

  async findById(id: string): Promise<TrackedProductRow | null> {
    const { data, error } = await supabase.from('tracked_products').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return (data as TrackedProductRow | null) ?? null;
  },

  async findByStoreProductId(storeProductId: number): Promise<TrackedProductRow | null> {
    const { data, error } = await supabase.from('tracked_products').select('*').eq('store_product_id', storeProductId).maybeSingle();
    if (error) throw error;
    return (data as TrackedProductRow | null) ?? null;
  },

  async create(input: CreateProductInput): Promise<TrackedProductRow> {
    const { data, error } = await supabase
      .from('tracked_products')
      .insert({
        canonical_url: input.canonicalUrl,
        store_product_id: input.storeProductId,
        name: input.name,
        category: input.category,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === PG_ERROR.UNIQUE_VIOLATION) throw new AlreadyTrackedError();
      throw error;
    }
    return data as TrackedProductRow;
  },

  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('tracked_products').delete().eq('id', id).select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundError(`Tracked product ${id} not found`);
  },

  /** Products due for a scrape. Wraps get_due_products() — the deadline math lives in Postgres, not Node. */
  async getDue(graceSeconds: number, force = false): Promise<TrackedProductRow[]> {
    const { data, error } = await supabase.rpc('get_due_products', { p_grace_seconds: graceSeconds, p_force: force });
    if (error) throw error;
    return (data ?? []) as TrackedProductRow[];
  },

  /** Per-product TTL lock. True = caller owns it now; false = another run holds it. */
  async tryLock(id: string, ttlSeconds: number): Promise<boolean> {
    const { data, error } = await supabase.rpc('try_lock_product', { p_product_id: id, p_ttl_seconds: ttlSeconds });
    if (error) throw error;
    return Boolean(data);
  },

  /** THE only path that writes a price_history row. See record_successful_scrape() in the migration. */
  async recordSuccess(productId: string, runId: string | null, snapshot: ValidatedSnapshot, attempt: number, durationMs: number): Promise<void> {
    const { error } = await supabase.rpc('record_successful_scrape', {
      p_product_id: productId,
      p_run_id: runId,
      p_attempt: attempt,
      p_price: snapshot.price,
      p_currency: snapshot.currency,
      p_stock: snapshot.stockStatus,
      p_raw_price_text: snapshot.rawPriceText,
      p_raw_stock_text: snapshot.rawStockText,
      p_method: snapshot.priceSource,
      p_duration_ms: Math.round(durationMs),
    });
    // A (product_id, run_id) unique-violation means a duplicate trigger raced us to the same
    // product/run and already recorded it — that is success, not an error, for the caller.
    if (error && error.code !== PG_ERROR.UNIQUE_VIOLATION) throw error;
  },

  /** Non-terminal attempt: logs RETRY and marks the product RETRYING. Never touches price/stock. */
  async recordRetry(productId: string, runId: string | null, info: AttemptFailure): Promise<void> {
    const { error } = await supabase.rpc('record_retry_attempt', {
      p_product_id: productId,
      p_run_id: runId,
      p_attempt: info.attempt,
      p_error_type: info.error.type,
      p_error_message: info.error.message,
      p_http_status: info.error.httpStatus,
      p_duration_ms: Math.round(info.durationMs),
      p_next_delay_ms: info.nextDelayMs,
      p_diagnostics: toDiagnosticsJson(info.error),
    });
    if (error) throw error;
  },

  /** Terminal failure. Previous known-good price/stock are left exactly as they were. */
  async recordFailure(productId: string, runId: string | null, error: ScrapeError, attempt: number, durationMs: number): Promise<void> {
    const { error: dbError } = await supabase.rpc('record_failed_scrape', {
      p_product_id: productId,
      p_run_id: runId,
      p_attempt: attempt,
      p_status: terminalStatusFor(error),
      p_error_type: error.type,
      p_error_message: error.message,
      p_http_status: error.httpStatus,
      p_duration_ms: Math.round(durationMs),
      p_diagnostics: toDiagnosticsJson(error),
    });
    if (dbError) throw dbError;
  },
};

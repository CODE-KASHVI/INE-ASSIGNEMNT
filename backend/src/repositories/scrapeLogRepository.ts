/**
 * Reads `scrape_logs`. Writes happen only inside the three RPCs
 * (record_successful_scrape / record_retry_attempt / record_failed_scrape); this file is
 * read-only by design so the dashboard's "every attempt, success or not" view can never
 * diverge from what actually happened.
 */
import { supabase } from '../config/supabase';
import type { ScrapeLogRow } from '../types/dto';
import type { CursorPage } from './historyRepository';

export const scrapeLogRepository = {
  async listForProduct(productId: string, limit: number, before: string | null): Promise<CursorPage<ScrapeLogRow>> {
    let query = supabase
      .from('scrape_logs')
      .select(
        'created_at, run_id, attempt_number, status, will_retry, message, error_type, error_message, duration_ms, extracted_price, extracted_stock, extraction_method',
      )
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (before) query = query.lt('created_at', before);

    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as ScrapeLogRow[];
    const nextBefore = rows.length === limit ? (rows[rows.length - 1]?.created_at ?? null) : null;
    return { rows, nextBefore };
  },
};

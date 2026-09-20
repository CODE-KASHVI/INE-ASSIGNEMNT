/**
 * Reads `price_history`. Nothing here ever writes a row — the only INSERT into this table is
 * inside `record_successful_scrape()` (supabase/migrations/0001_init.sql), so a failed or
 * uncertain scrape cannot produce a history entry no matter what code path called it.
 */
import { supabase } from '../config/supabase';
import type { PriceHistoryRow } from '../types/dto';

export interface CursorPage<T> {
  rows: T[];
  nextBefore: string | null;
}

export const historyRepository = {
  async listForProduct(productId: string, limit: number, before: string | null): Promise<CursorPage<PriceHistoryRow>> {
    let query = supabase
      .from('price_history')
      .select('scraped_at, price, currency, stock_status')
      .eq('product_id', productId)
      .order('scraped_at', { ascending: false })
      .limit(limit);

    if (before) query = query.lt('scraped_at', before);

    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as PriceHistoryRow[];
    // nextBefore is null (not merely absent) once a page comes back short of `limit` — that is
    // the frontend's "stop paging" signal, distinct from a legitimately empty page mid-range.
    const nextBefore = rows.length === limit ? (rows[rows.length - 1]?.scraped_at ?? null) : null;
    return { rows, nextBefore };
  },
};

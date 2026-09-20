/**
 * Wraps `scrape_runs` and the `claim_scrape_run()` RPC. Claiming is how a duplicate cron
 * trigger (cron-job.org retrying, or two overlapping ticks) gets absorbed as a no-op instead
 * of launching a second full scrape pass — see docs/architecture.md's request-flow trace for
 * `POST /api/scrape/run`.
 */
import { supabase } from '../config/supabase';

export type TriggerSource = 'CRON' | 'MANUAL' | 'INITIAL' | 'CLI';

export interface RunTallies {
  productsTotal: number;
  productsSuccess: number;
  productsFailed: number;
  productsSkipped: number;
}

export const runRepository = {
  /** Returns a new run id, or null if this trigger was absorbed as a duplicate. */
  async claim(source: TriggerSource, dedupeWindowSeconds: number, staleSeconds: number): Promise<string | null> {
    const { data, error } = await supabase.rpc('claim_scrape_run', {
      p_source: source,
      p_dedupe_window_seconds: dedupeWindowSeconds,
      p_stale_seconds: staleSeconds,
    });
    if (error) throw error;
    return (data as string | null) ?? null;
  },

  async complete(runId: string, tallies: RunTallies, status: 'COMPLETED' | 'PARTIAL' | 'FAILED' = 'COMPLETED'): Promise<void> {
    const finalStatus = status === 'COMPLETED' && tallies.productsFailed > 0 ? 'PARTIAL' : status;
    const { error } = await supabase
      .from('scrape_runs')
      .update({
        status: finalStatus,
        completed_at: new Date().toISOString(),
        products_total: tallies.productsTotal,
        products_success: tallies.productsSuccess,
        products_failed: tallies.productsFailed,
        products_skipped: tallies.productsSkipped,
      })
      .eq('id', runId);
    if (error) throw error;
  },
};

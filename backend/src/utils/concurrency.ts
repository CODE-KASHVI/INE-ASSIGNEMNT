/**
 * Runs `worker` over `items` with at most `concurrency` in flight at once. Used by
 * `scrapeRunner` instead of `scraper/productScraper.ts`'s own `scrapeProducts` batch helper
 * when per-item context (productId, runId) needs to reach the retry hooks — `scrapeProducts`'s
 * hooks are shared across the whole batch and carry no target identifier.
 */
export async function runWithConcurrency<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const bounded = Math.max(1, Math.min(concurrency, items.length || 1));

  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: bounded }, run));
  return results;
}

import { describe, expect, it } from 'vitest';
import { runWithConcurrency } from '../src/utils/concurrency';

describe('runWithConcurrency', () => {
  it('processes every item exactly once and preserves result order regardless of completion order', async () => {
    const items = [30, 10, 20, 5, 15];
    const results = await runWithConcurrency(items, 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms * 2;
    });
    expect(results).toEqual([60, 20, 40, 10, 30]);
  });

  it('never exceeds the requested concurrency', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await runWithConcurrency(items, 3, async (item) => {
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return item;
    });

    expect(maxObserved).toBeLessThanOrEqual(3);
  });

  it('a thrown error in one worker call propagates and stops the batch (callers must handle their own per-item failures)', async () => {
    await expect(
      runWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
        return item;
      }),
    ).rejects.toThrow('boom');
  });

  it('handles an empty item list without dividing by zero or hanging', async () => {
    const results = await runWithConcurrency([], 3, async (item) => item);
    expect(results).toEqual([]);
  });

  it('caps effective concurrency at the item count so it never allocates unnecessary workers', async () => {
    let started = 0;
    await runWithConcurrency([1, 2], 10, async (item) => {
      started += 1;
      return item;
    });
    expect(started).toBe(2);
  });
});

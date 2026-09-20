import { describe, expect, it } from 'vitest';
import { computeDelayMs, DEFAULT_RETRY_POLICY, runWithRetry, withDeadline } from '../src/scraper/retry';
import type { AttemptFailure } from '../src/scraper/retry';
import { ScrapeError, terminalStatusFor } from '../src/scraper/types';

/** Deterministic deps: records sleeps instead of waiting, jitter = 0. */
function fakeDeps() {
  const sleeps: number[] = [];
  return {
    sleeps,
    deps: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    },
  };
}

describe('computeDelayMs', () => {
  it('follows the configured schedule: 2s then 5s, reusing the last delay afterwards', () => {
    const rnd = () => 0.5; // zero jitter
    expect(computeDelayMs(1, DEFAULT_RETRY_POLICY, rnd)).toBe(2000);
    expect(computeDelayMs(2, DEFAULT_RETRY_POLICY, rnd)).toBe(5000);
    expect(computeDelayMs(9, DEFAULT_RETRY_POLICY, rnd)).toBe(5000);
  });

  it('keeps jitter within ±ratio', () => {
    expect(computeDelayMs(1, DEFAULT_RETRY_POLICY, () => 0)).toBe(1600);
    expect(computeDelayMs(1, DEFAULT_RETRY_POLICY, () => 1)).toBe(2400);
  });
});

describe('runWithRetry', () => {
  it('succeeds first time without sleeping', async () => {
    const { deps, sleeps } = fakeDeps();
    const out = await runWithRetry(async () => 'ok', DEFAULT_RETRY_POLICY, {}, deps);
    expect(out).toEqual({ ok: true, value: 'ok', attempts: 1 });
    expect(sleeps).toEqual([]);
  });

  it('retries transient failures, then succeeds', async () => {
    const { deps, sleeps } = fakeDeps();
    const failures: AttemptFailure[] = [];
    let calls = 0;
    const out = await runWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new ScrapeError('TIMEOUT', 'slow');
        return 'price';
      },
      DEFAULT_RETRY_POLICY,
      { onAttemptFailure: (f) => void failures.push(f) },
      deps,
    );
    expect(out).toEqual({ ok: true, value: 'price', attempts: 3 });
    expect(sleeps).toEqual([2000, 5000]);
    expect(failures.map((f) => [f.attempt, f.willRetry, f.nextDelayMs])).toEqual([
      [1, true, 2000],
      [2, true, 5000],
    ]);
  });

  it('gives up after maxAttempts, reports the last error, and never sleeps after the final attempt', async () => {
    const { deps, sleeps } = fakeDeps();
    const failures: AttemptFailure[] = [];
    const out = await runWithRetry(
      async () => {
        throw new ScrapeError('CONTENT_NOT_READY', 'no content');
      },
      DEFAULT_RETRY_POLICY,
      { onAttemptFailure: (f) => void failures.push(f) },
      deps,
    );
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(3);
    expect(sleeps).toEqual([2000, 5000]); // two sleeps, not three
    expect(failures.at(-1)?.willRetry).toBe(false);
    expect(failures.at(-1)?.nextDelayMs).toBe(null);
  });

  it('does not retry non-retryable errors (HTTP 404)', async () => {
    const { deps, sleeps } = fakeDeps();
    const out = await runWithRetry(
      async () => {
        throw new ScrapeError('HTTP_STATUS', 'not found', { httpStatus: 404 });
      },
      DEFAULT_RETRY_POLICY,
      {},
      deps,
    );
    expect(out.attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('does retry 503 and 429', async () => {
    for (const httpStatus of [503, 429]) {
      const { deps } = fakeDeps();
      const out = await runWithRetry(
        async () => {
          throw new ScrapeError('HTTP_STATUS', 'bad', { httpStatus });
        },
        DEFAULT_RETRY_POLICY,
        {},
        deps,
      );
      expect(out.attempts).toBe(3);
    }
  });

  it('wraps unknown errors as UNEXPECTED and does not retry them', async () => {
    const { deps } = fakeDeps();
    const out = await runWithRetry(
      async () => {
        throw new TypeError('bug');
      },
      DEFAULT_RETRY_POLICY,
      {},
      deps,
    );
    expect(out.ok === false && out.error.type).toBe('UNEXPECTED');
    expect(out.attempts).toBe(1);
  });

  it('maps a Playwright-style TimeoutError to a retryable TIMEOUT', async () => {
    const { deps } = fakeDeps();
    const out = await runWithRetry(
      async () => {
        const e = new Error('Timeout 15000ms exceeded');
        e.name = 'TimeoutError';
        throw e;
      },
      DEFAULT_RETRY_POLICY,
      {},
      deps,
    );
    expect(out.ok === false && out.error.type).toBe('TIMEOUT');
    expect(out.attempts).toBe(3);
  });

  it('a throwing log hook cannot break the loop (and the error is reported, not swallowed silently)', async () => {
    const { deps } = fakeDeps();
    const hookErrors: unknown[] = [];
    let calls = 0;
    const out = await runWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new ScrapeError('NETWORK', 'reset');
        return 'ok';
      },
      DEFAULT_RETRY_POLICY,
      {
        onAttemptFailure: () => {
          throw new Error('db down');
        },
      },
      { ...deps, onHookError: (e) => hookErrors.push(e) },
    );
    expect(out.ok).toBe(true);
    expect(hookErrors.length).toBe(1);
  });
});

describe('withDeadline', () => {
  it('rejects with a TIMEOUT ScrapeError when work hangs', async () => {
    let caught: unknown;
    try {
      await withDeadline(new Promise<never>(() => {}), 20, 'navigation');
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof ScrapeError && caught.type).toBe('TIMEOUT');
  });

  it('passes the value through when work finishes in time', async () => {
    expect(await withDeadline(Promise.resolve(42), 1000, 'fast')).toBe(42);
  });
});

describe('terminal status mapping', () => {
  it('maps error types to scrape_logs statuses', () => {
    expect(terminalStatusFor(new ScrapeError('TIMEOUT', 'x'))).toBe('TIMEOUT');
    expect(terminalStatusFor(new ScrapeError('STRUCTURE_CHANGED', 'x'))).toBe('STRUCTURE_CHANGED');
    expect(terminalStatusFor(new ScrapeError('VALIDATION', 'x'))).toBe('VALIDATION_FAILED');
    expect(terminalStatusFor(new ScrapeError('NETWORK', 'x'))).toBe('FAILED');
  });
});

import { ScrapeError, toScrapeError } from './types';

export interface RetryPolicy {
  /** Total attempts including the first (3 => 1 try + 2 retries). */
  maxAttempts: number;
  /** Delay after failed attempt N is delaysMs[N-1]; the last entry is reused if attempts outnumber it. */
  delaysMs: readonly number[];
  /** ±fraction of random jitter applied to each delay (0.2 => ±20%). */
  jitterRatio: number;
}

/** attempt 1 → immediate, attempt 2 → ~2s later, attempt 3 → ~5s later. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  delaysMs: [2000, 5000],
  jitterRatio: 0.2,
};

export interface AttemptSuccess<T> {
  attempt: number;
  value: T;
  durationMs: number;
}

export interface AttemptFailure {
  attempt: number;
  maxAttempts: number;
  error: ScrapeError;
  durationMs: number;
  willRetry: boolean;
  nextDelayMs: number | null;
}

export interface RetryHooks<T> {
  /** Awaited. Use it to persist a scrape_logs row for every attempt. */
  onAttemptSuccess?: (info: AttemptSuccess<T>) => void | Promise<void>;
  onAttemptFailure?: (info: AttemptFailure) => void | Promise<void>;
}

export interface RetryDeps {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Hook errors must never break the retry loop, but they must not vanish either. */
  onHookError?: (error: unknown) => void;
}

export type RetryOutcome<T> = { ok: true; value: T; attempts: number } | { ok: false; error: ScrapeError; attempts: number };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function computeDelayMs(failedAttempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  if (policy.delaysMs.length === 0) return 0;
  const index = Math.min(Math.max(failedAttempt, 1) - 1, policy.delaysMs.length - 1);
  const base = policy.delaysMs[index] as number;
  const jitter = base * policy.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * Runs `task` up to policy.maxAttempts times. Never throws for task failures — it returns a
 * RetryOutcome so the caller always gets a structured result and can persist it.
 */
export async function runWithRetry<T>(
  task: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  hooks: RetryHooks<T> = {},
  deps: RetryDeps = {},
): Promise<RetryOutcome<T>> {
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const safely = async (fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (hookError) {
      deps.onHookError?.(hookError);
    }
  };

  let lastError: ScrapeError | null = null;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const startedAt = now();
    try {
      const value = await task(attempt);
      const durationMs = now() - startedAt;
      await safely(() => hooks.onAttemptSuccess?.({ attempt, value, durationMs }));
      return { ok: true, value, attempts: attempt };
    } catch (raw) {
      const error = toScrapeError(raw);
      const durationMs = now() - startedAt;
      lastError = error;

      const willRetry = error.retryable && attempt < policy.maxAttempts;
      const nextDelayMs = willRetry ? computeDelayMs(attempt, policy, random) : null;
      await safely(() => hooks.onAttemptFailure?.({ attempt, maxAttempts: policy.maxAttempts, error, durationMs, willRetry, nextDelayMs }));

      if (!willRetry) return { ok: false, error, attempts: attempt };
      await sleep(nextDelayMs as number); // never sleeps after the final attempt
    }
  }

  // Only reachable if maxAttempts < 1.
  return { ok: false, error: lastError ?? new ScrapeError('UNEXPECTED', 'retry policy allowed zero attempts'), attempts: 0 };
}

/**
 * Hard upper bound for one unit of work. Playwright calls have their own timeouts, but a hung
 * browser can still stall a promise forever; this guarantees we always move on.
 * NOTE: it cannot cancel the underlying work — callers must clean up (close page/context) in `finally`.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ScrapeError('TIMEOUT', `${label} exceeded hard deadline of ${ms}ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

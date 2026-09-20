export const STOCK_STATUSES = ['IN_STOCK', 'OUT_OF_STOCK', 'UNKNOWN'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/** The only stock values that may ever be persisted. UNKNOWN means "fail the scrape". */
export type ConfirmedStockStatus = Exclude<StockStatus, 'UNKNOWN'>;

/** Values of scrape_logs.status. */
export const SCRAPE_LOG_STATUSES = ['SUCCESS', 'RETRY', 'FAILED', 'VALIDATION_FAILED', 'TIMEOUT', 'STRUCTURE_CHANGED'] as const;
export type ScrapeLogStatus = (typeof SCRAPE_LOG_STATUSES)[number];

/** Terminal (non-success, non-retry) statuses accepted by record_failed_scrape(). */
export type TerminalFailureStatus = Exclude<ScrapeLogStatus, 'SUCCESS' | 'RETRY'>;

export type ScrapeErrorType =
  | 'NETWORK' //           DNS / connection reset / fetch failed
  | 'TIMEOUT' //           any explicit timeout or deadline
  | 'HTTP_STATUS' //       non-2xx response
  | 'BROWSER' //           browser crashed / failed to launch / page closed
  | 'CONTENT_NOT_READY' // page loaded but has no product content (yet)
  | 'STRUCTURE_CHANGED' // product title present, but no known price selector matched
  | 'VALIDATION' //        extracted values failed validation (placeholder, malformed, uncertain stock ...)
  | 'UNEXPECTED'; //       bug / unknown — never retried

export interface ScrapeErrorOptions {
  retryable?: boolean;
  httpStatus?: number | null;
  diagnostics?: Record<string, unknown> | null;
  cause?: unknown;
}

/**
 * Retry policy by error type.
 * - 4xx (except 408/425/429) will not fix themselves → no retry.
 * - UNEXPECTED means "probably a bug in our code" → no retry, surface it immediately.
 * - STRUCTURE_CHANGED *is* retried: an async page may simply not have rendered the price yet.
 *   If every attempt ends the same way, the final log row is STRUCTURE_CHANGED.
 */
export function defaultRetryable(type: ScrapeErrorType, httpStatus?: number | null): boolean {
  switch (type) {
    case 'HTTP_STATUS':
      return httpStatus == null ? true : httpStatus === 408 || httpStatus === 425 || httpStatus === 429 || httpStatus >= 500;
    case 'UNEXPECTED':
      return false;
    default:
      return true;
  }
}

export class ScrapeError extends Error {
  readonly type: ScrapeErrorType;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly diagnostics: Record<string, unknown> | null;

  constructor(type: ScrapeErrorType, message: string, options: ScrapeErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ScrapeError';
    this.type = type;
    this.httpStatus = options.httpStatus ?? null;
    this.diagnostics = options.diagnostics ?? null;
    this.retryable = options.retryable ?? defaultRetryable(type, options.httpStatus);
  }
}

/** Maps a final error to the status stored on the terminal scrape_logs row. */
export function terminalStatusFor(error: ScrapeError): TerminalFailureStatus {
  switch (error.type) {
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'STRUCTURE_CHANGED':
      return 'STRUCTURE_CHANGED';
    case 'VALIDATION':
      return 'VALIDATION_FAILED';
    default:
      return 'FAILED';
  }
}

/** Normalises anything thrown (including Playwright's TimeoutError) into a ScrapeError. */
export function toScrapeError(error: unknown): ScrapeError {
  if (error instanceof ScrapeError) return error;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ScrapeError('TIMEOUT', message, { cause: error });
  }
  return new ScrapeError('UNEXPECTED', message, { cause: error });
}

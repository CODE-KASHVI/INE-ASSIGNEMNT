/**
 * Typed errors thrown by services/repositories. `middleware/errorHandler.ts` is the only place
 * that turns these into HTTP status codes (see docs/architecture.md "Error → status code mapping").
 */

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class AlreadyTrackedError extends Error {
  readonly code = 'ALREADY_TRACKED';
  constructor(message = 'This product is already tracked') {
    super(message);
    this.name = 'AlreadyTrackedError';
  }
}

export class ValidationFailedError extends Error {
  readonly code = 'VALIDATION_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationFailedError';
  }
}

export class ScrapeInProgressError extends Error {
  readonly code = 'SCRAPE_IN_PROGRESS';
  constructor(message = 'A scrape for this product is already running') {
    super(message);
    this.name = 'ScrapeInProgressError';
  }
}

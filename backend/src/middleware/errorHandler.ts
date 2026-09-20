/**
 * The single place a thrown/rejected error becomes an HTTP response. See
 * docs/architecture.md "Error → status code mapping". Every response shares one envelope:
 *   { "error": { "code": "...", "message": "..." } }
 * Raw Postgres/Playwright error text is logged server-side only — never handed to the client.
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { UrlNotAllowedError } from '../utils/url';
import { AlreadyTrackedError, NotFoundError, ScrapeInProgressError, ValidationFailedError } from '../types/errors';

interface ErrorBody {
  code: string;
  message: string;
}

function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof UrlNotAllowedError) return { status: 400, body: { code: error.code, message: error.message } };
  if (error instanceof ValidationFailedError) return { status: 400, body: { code: error.code, message: error.message } };
  if (error instanceof ZodError) {
    const message = error.issues.map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`).join('; ');
    return { status: 400, body: { code: 'VALIDATION_FAILED', message } };
  }
  if (error instanceof NotFoundError) return { status: 404, body: { code: error.code, message: error.message } };
  if (error instanceof AlreadyTrackedError) return { status: 409, body: { code: error.code, message: error.message } };
  if (error instanceof ScrapeInProgressError) return { status: 409, body: { code: error.code, message: error.message } };

  return { status: 500, body: { code: 'INTERNAL', message: 'Something went wrong processing that request' } };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express identifies error middleware by arity (4 params)
export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  const { status, body } = toErrorBody(error);

  const logPayload = {
    event: 'request_error',
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    status,
    code: body.code,
    message: error instanceof Error ? error.message : String(error),
  };
  if (status >= 500) console.error(JSON.stringify(logPayload));
  else console.warn(JSON.stringify(logPayload));

  res.status(status).json({ error: body });
}

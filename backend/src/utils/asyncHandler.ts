/**
 * Express does not forward a rejected promise from an async handler to `next()` on its own
 * (true for the Express 4 line this project targets). Every route handler is wrapped in this
 * so a thrown/rejected error always reaches `middleware/errorHandler.ts` instead of hanging
 * the request or crashing the process.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

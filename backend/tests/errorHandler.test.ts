import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { errorHandler } from '../src/middleware/errorHandler';
import { UrlNotAllowedError } from '../src/utils/url';
import { AlreadyTrackedError, NotFoundError, ScrapeInProgressError, ValidationFailedError } from '../src/types/errors';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

/** The body passed to the most recent res.json() call. */
function lastPayload(res: Response): { error: { code: string; message: string } } {
  const calls = (res.json as ReturnType<typeof vi.fn>).mock.calls;
  const payload = calls[calls.length - 1]?.[0];
  if (!payload) throw new Error('res.json was never called');
  return payload;
}

function mockReq(): Request {
  return { requestId: 'req-1', method: 'GET', path: '/api/products/x' } as unknown as Request;
}

describe('errorHandler', () => {
  const cases: Array<[Error, number, string]> = [
    [new UrlNotAllowedError('bad host'), 400, 'URL_NOT_ALLOWED'],
    [new ValidationFailedError('missing field'), 400, 'VALIDATION_FAILED'],
    [new NotFoundError('not found'), 404, 'NOT_FOUND'],
    [new AlreadyTrackedError(), 409, 'ALREADY_TRACKED'],
    [new ScrapeInProgressError(), 409, 'SCRAPE_IN_PROGRESS'],
    [new Error('some random bug'), 500, 'INTERNAL'],
  ];

  for (const [error, expectedStatus, expectedCode] of cases) {
    it(`maps ${error.constructor.name} to ${expectedStatus} ${expectedCode}`, () => {
      const res = mockRes();
      errorHandler(error, mockReq(), res, vi.fn());
      expect(res.status).toHaveBeenCalledWith(expectedStatus);
      expect(res.json).toHaveBeenCalledWith({ error: { code: expectedCode, message: expect.any(String) } });
    });
  }

  it('never leaks a raw error message for an unrecognised (500) error — the client gets a generic message', () => {
    const res = mockRes();
    errorHandler(new Error('SELECT * FROM tracked_products failed: password auth failed for user'), mockReq(), res, vi.fn());
    const payload = lastPayload(res);
    expect(payload.error.message).not.toContain('password');
  });

  it('maps a ZodError to 400 VALIDATION_FAILED with a readable path-based message', () => {
    const schema = z.object({ q: z.string().min(1) });
    const result = schema.safeParse({ q: '' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');

    const res = mockRes();
    errorHandler(result.error, mockReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    const payload = lastPayload(res);
    expect(payload.error.code).toBe('VALIDATION_FAILED');
    expect(payload.error.message).toContain('q');
  });
});

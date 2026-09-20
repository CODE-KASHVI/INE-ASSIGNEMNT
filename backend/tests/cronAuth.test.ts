import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// config/env.ts validates process.env at import time, so the required variables must be set
// BEFORE the module graph is evaluated. A dynamic import() (rather than a static one) lets this
// file set them first, in beforeAll, instead of racing hoisted static imports.
let cronAuth: typeof import('../src/middleware/cronAuth').cronAuth;

beforeAll(async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-that-is-long-enough';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  process.env.CRON_SECRET = 'a-very-long-test-cron-secret-value';
  ({ cronAuth } = await import('../src/middleware/cronAuth'));
});

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function mockReq(authHeader?: string): Request {
  return { header: (name: string) => (name.toLowerCase() === 'authorization' ? authHeader : undefined) } as unknown as Request;
}

describe('cronAuth', () => {
  it('calls next() when the Bearer token matches CRON_SECRET exactly', () => {
    const next = vi.fn();
    cronAuth(mockReq('Bearer a-very-long-test-cron-secret-value'), mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('responds 401 UNAUTHORIZED when the Authorization header is missing entirely', () => {
    const next = vi.fn();
    const res = mockRes();
    cronAuth(mockReq(undefined), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
  });

  it('responds 401 when the token is present but wrong', () => {
    const next = vi.fn();
    const res = mockRes();
    cronAuth(mockReq('Bearer totally-the-wrong-secret'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('responds 401 when the scheme is not Bearer', () => {
    const next = vi.fn();
    const res = mockRes();
    cronAuth(mockReq('Basic a-very-long-test-cron-secret-value'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

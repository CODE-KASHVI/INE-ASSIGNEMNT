/**
 * Guards POST /api/scrape/run. cron-job.org sends `Authorization: Bearer <CRON_SECRET>`; this
 * checks it BEFORE the controller does anything else, so an unauthenticated request never
 * reaches the database or launches a browser.
 */
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';

/** Constant-time-ish comparison: cheap insurance against timing side-channels on a secret check. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function cronAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token || !safeEqual(token, env.CRON_SECRET)) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid cron bearer token' } });
    return;
  }
  next();
}

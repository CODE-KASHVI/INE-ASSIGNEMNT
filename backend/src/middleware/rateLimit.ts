/**
 * Two limiters:
 *  - searchLimiter: generous, just stops a runaway client from hammering the catalogue fetch.
 *  - manualScrapeLimiter: 1 request per product per 10s per IP (docs/api-design.md), so a
 *    double-click or a stuck "Scrape Now" spinner retry can't spawn a pile of Playwright
 *    contexts. Keyed on IP + product id, not IP alone, so scraping product A doesn't rate-limit
 *    a request for product B.
 */
import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

export const searchLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many search requests, slow down' } },
});

export const manualScrapeLimiter = rateLimit({
  windowMs: 10_000,
  limit: 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => `${req.ip}:${req.params.id}`,
  message: { error: { code: 'RATE_LIMITED', message: 'A scrape for this product was just requested — try again shortly' } },
});

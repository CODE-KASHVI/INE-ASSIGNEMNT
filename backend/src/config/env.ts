/**
 * Validated environment configuration.
 *
 * Read once, at import time, and thrown on immediately if anything required is missing or
 * malformed — a bad deploy should fail at boot (visible in Render's logs, service never comes
 * up) rather than on the first request a user happens to send.
 */
import { z } from 'zod';

const numberFromString = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : Number(value)))
    .pipe(z.number().finite());

const boolFromString = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : value.toLowerCase() === 'true'));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: numberFromString(5000),

  // Supabase — the service-role key is server-only and must never reach the frontend bundle.
  SUPABASE_URL: z.string().url({ message: 'SUPABASE_URL must be a valid URL' }),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, 'SUPABASE_SERVICE_ROLE_KEY looks too short to be real'),

  // CORS: the frontend origin, exact match, no wildcard.
  FRONTEND_URL: z.string().url({ message: 'FRONTEND_URL must be a valid URL' }),

  // cron-job.org authenticates with this as a Bearer token against POST /api/scrape/run.
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters'),

  // Scraper tuning. Defaults mirror backend/src/scraper/retry.ts and reveal.ts's own defaults
  // so an operator only needs to set these when overriding, not to get a working baseline.
  SCRAPER_HEADLESS: boolFromString(true),
  SCRAPER_MAX_RETRIES: numberFromString(3),
  SCRAPER_NAVIGATION_TIMEOUT_MS: numberFromString(30_000),
  SCRAPER_SELECTOR_TIMEOUT_MS: numberFromString(15_000),
  SCRAPER_REVEAL_TIMEOUT_MS: numberFromString(20_000),
  SCRAPER_CONCURRENCY: numberFromString(3),

  // How the "is this product due" and "is this a duplicate cron trigger" windows behave.
  SCRAPE_INTERVAL_HOURS_DEFAULT: numberFromString(2),
  SCRAPE_DUE_GRACE_SECONDS: numberFromString(600),
  SCRAPE_CRON_DEDUPE_WINDOW_SECONDS: numberFromString(3600),
  SCRAPE_RUN_STALE_SECONDS: numberFromString(900),
  SCRAPE_LOCK_TTL_SECONDS: numberFromString(300),
});

function loadEnv() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    // Thrown synchronously at import time — server.ts never reaches app.listen() on a bad config.
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example for the full list of variables.`);
  }
  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';

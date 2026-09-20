/**
 * The one Supabase client in the codebase. Only `repositories/*` may import this — that
 * boundary is what lets `services/*` be unit-tested without a database.
 *
 * Uses the service_role key deliberately: every table has RLS enabled with NO policies
 * (see supabase/migrations/0001_init.sql), so the anon/authenticated roles can do nothing at
 * all and only this server-side key can read or write. It must never be sent to the frontend.
 */
import { createClient } from '@supabase/supabase-js';
import { env } from './env';

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: 'public' },
});

/** Postgres error codes the repositories check for by name, instead of magic strings inline. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
} as const;

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client — created ONLY from the public anon key.
 *
 * - VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY are safe to expose in
 *   browser code (RLS enforces access). The SERVICE-ROLE key must
 *   NEVER appear here or anywhere under src/ — it lives only as an
 *   Edge Function secret (see SUPABASE.md).
 * - If env vars are absent, this returns null and the app runs in
 *   clearly-labelled Demo mode with the mock service.
 * - Keys are never logged.
 */

let client: SupabaseClient | null | undefined;

export function isSupabaseConfigured(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
}

export function getSupabaseClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anonKey) {
    client = null;
    return null;
  }
  client = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return client;
}

/**
 * Ensure an anonymous session exists. Idempotent: returns the existing
 * session when already signed in. Surfaces a clear error when
 * anonymous auth is disabled in the Supabase project.
 */
export async function ensureAnonymousAuth(): Promise<{ userId: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session?.user) return { userId: sessionData.session.user.id };
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.user) {
    throw new Error(
      'Anonymous sign-in failed. Enable Anonymous auth in Supabase: Authentication > Providers > Anonymous. ' +
        `(${error?.message ?? 'unknown error'})`,
    );
  }
  return { userId: data.user.id };
}

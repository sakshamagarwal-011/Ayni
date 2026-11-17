// Shared auth helpers for MeetSync 3D Edge Functions (server-only).
// The SERVICE-ROLE key is read here from Edge Function secrets only.
// It must NEVER be exposed to browser code or included in responses.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing server secret: ${name}`);
  return value;
}

/** Service-role client: bypasses RLS. Use only after verifying the caller. */
export function getServiceClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Verify the caller's Bearer JWT and return their user id.
 * Returns null when the token is missing/invalid — callers must 401.
 */
export async function getUserIdFromRequest(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length);
  const client = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

export async function readJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

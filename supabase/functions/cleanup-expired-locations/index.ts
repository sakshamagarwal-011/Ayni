// cleanup-expired-locations — scheduled cleanup job.
// Auth: x-cron-secret header must equal the CLEANUP_SECRET Edge Function
// secret. Fails closed when the secret is not configured. Invoke via
// Supabase Scheduled Functions (cron) or pg_cron calling the SQL
// functions directly — see SUPABASE.md. Never expose CLEANUP_SECRET to
// the browser.
//
// Each run, in order:
//  1. Delete expired participant_locations (delete_expired_locations).
//  2. Mark past-expires_at open rooms 'expired' (expire_rooms).
//     Finalized rooms are never auto-expired.
//  3. Prune expired/finalized rooms whose expires_at is older than the
//     retention window (CLEANUP_RETENTION_DAYS, default 7, clamped
//     1..90). Cascades to participants, locations, spots, estimates
//     and votes. Non-expired rooms are never deleted.
import { getServiceClient } from '../_shared/auth.ts';
import { handleOptions, jsonError, jsonResponse } from '../_shared/cors.ts';

function retentionDays(): number {
  const raw = Deno.env.get('CLEANUP_RETENTION_DAYS');
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 7;
  return Math.min(90, Math.max(1, Math.floor(parsed)));
}

/**
 * Constant-time secret comparison (no dependency): compares every byte
 * of both values and accumulates differences with XOR, so the runtime
 * does not depend on where the first mismatch is. Lengths are folded
 * into the accumulator rather than short-circuiting.
 */
function secretsEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== 'POST') return jsonError('Method not allowed.', 405);

  try {
    const secret = Deno.env.get('CLEANUP_SECRET');
    if (!secret) return jsonError('Cleanup is not configured.', 500);
    const provided = req.headers.get('x-cron-secret');
    if (!provided || !secretsEqual(provided, secret)) return jsonError('Unauthorized.', 401);

    const service = getServiceClient();

    const { data: deletedLocations, error: locError } = await service.rpc('delete_expired_locations');
    if (locError) return jsonError('Cleanup failed.', 500);

    const { data: expiredRooms, error: expireError } = await service.rpc('expire_rooms');
    if (expireError) return jsonError('Cleanup failed.', 500);

    const days = retentionDays();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data: prunedRooms, error: roomError } = await service
      .from('meeting_rooms')
      .delete()
      .in('status', ['expired', 'finalized'])
      .lt('expires_at', cutoff)
      .select('id');
    if (roomError) return jsonError('Cleanup failed.', 500);

    return jsonResponse({
      deletedLocations: (deletedLocations as number | null) ?? 0,
      expiredRooms: (expiredRooms as number | null) ?? 0,
      prunedRooms: (prunedRooms ?? []).length,
      retentionDays: days,
      ranAt: new Date().toISOString(),
    });
  } catch {
    return jsonError('Internal error.', 500);
  }
});

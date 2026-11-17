// create-room — creates a meeting room + host participant.
// Auth: Bearer JWT (anonymous auth). Writes use the service-role client.
// Rate limiting: rely on Supabase Edge Function + Auth rate limits; add an
// upstream gateway limit for production use. See SUPABASE.md.
//
// New rooms start with ZERO candidate spots (since v0.7.3): the old
// server-side seeding of three Bengaluru demo spots was removed —
// demo venues thousands of kilometres away were noise in real rooms,
// and their estimates crowded the UI. Spots arrive only via
// publish-results, which upserts live search results as votable rows.
// Demo mode (mockService) still seeds sample spots; that divergence is
// deliberate and documented in SUPABASE.md. Existing rooms keep the
// spots they already have — no data migration touches them.
import { getServiceClient, getUserIdFromRequest, readJsonBody } from '../_shared/auth.ts';
import { handleOptions, jsonError, jsonResponse } from '../_shared/cors.ts';
import {
  avatarColorFor,
  generateInviteCode,
  validateAccuracyM,
  validateDisplayName,
  validateLatLng,
  validateTitle,
} from '../_shared/validation.ts';

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== 'POST') return jsonError('Method not allowed.', 405);

  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) return jsonError('Unauthorized.', 401);

    const body = await readJsonBody<{
      title?: unknown;
      displayName?: unknown;
      lat?: unknown;
      lng?: unknown;
      label?: unknown;
      accuracyM?: unknown;
    }>(req);
    if (!body) return jsonError('Invalid JSON body.', 400);

    const titleError = validateTitle(body.title);
    if (titleError) return jsonError(titleError, 400);
    const nameError = validateDisplayName(body.displayName);
    if (nameError) return jsonError(nameError, 400);
    const locError = validateLatLng(body.lat, body.lng);
    if (locError) return jsonError(locError, 400);
    const acc = validateAccuracyM(body.accuracyM);
    if (acc.error) return jsonError(acc.error, 400);
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 60) : 'Starting point';

    const service = getServiceClient();

    // Retry on invite-code unique violation (max 5 attempts).
    let room: Record<string, unknown> | null = null;
    let lastError: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const inviteCode = generateInviteCode();
      const { data, error } = await service
        .from('meeting_rooms')
        .insert({
          invite_code: inviteCode,
          title: (body.title as string).trim(),
          host_auth_uid: userId,
          status: 'lobby',
        })
        .select('*')
        .single();
      if (!error && data) {
        room = data as Record<string, unknown>;
        break;
      }
      // Postgres unique_violation = 23505. Any other error fails fast.
      const code = (error as { code?: string } | null)?.code;
      lastError = error?.message ?? 'Failed to create room.';
      if (code !== '23505') return jsonError('Failed to create room.', 500);
    }
    if (!room) {
      // Never leak the raw DB error to the client after collision
      // exhaustion — log it server-side only.
      console.error('create-room: invite code collisions exhausted', lastError);
      return jsonError('Failed to create room. Please try again.', 500);
    }

    const roomId = room['id'] as string;
    const inviteCode = room['invite_code'] as string;

    const { data: participant, error: pError } = await service
      .from('participants')
      .insert({
        room_id: roomId,
        auth_uid: userId,
        display_name: (body.displayName as string).trim(),
        avatar_color: avatarColorFor(userId),
        is_host: true,
        is_ready: false,
      })
      .select('*')
      .single();
    if (pError || !participant) {
      // Roll back the orphaned room (best effort).
      await service.from('meeting_rooms').delete().eq('id', roomId);
      return jsonError('Failed to create room.', 500);
    }

    const participantId = (participant as { id: string }).id;
    // A location failure must roll the room back: a room with no host
    // location is silently broken. Previously this error was ignored
    // (M-10). No spots are seeded here — new rooms start empty and
    // spots arrive via publish-results, so there is no spots-insert
    // failure to handle.
    const { error: locInsertError } = await service.from('participant_locations').insert({
      participant_id: participantId,
      room_id: roomId,
      lat: body.lat,
      lng: body.lng,
      label,
      accuracy_m: acc.accuracyM,
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    });
    if (locInsertError) {
      await service.from('meeting_rooms').delete().eq('id', roomId);
      return jsonError('Failed to create room.', 500);
    }

    return jsonResponse({
      room,
      participant,
      inviteCode,
      joinPath: `/join/${inviteCode}`,
    });
  } catch {
    return jsonError('Internal error.', 500);
  }
});

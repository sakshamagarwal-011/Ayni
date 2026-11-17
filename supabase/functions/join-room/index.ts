// join-room — idempotent join by invite code.
// Auth: Bearer JWT. Room lookup uses the service-role client because RLS
// blocks non-member SELECT on meeting_rooms by design. Returns a generic
// 404 message that does not leak whether a code exists vs. expired.
import { getServiceClient, getUserIdFromRequest, readJsonBody } from '../_shared/auth.ts';
import { handleOptions, jsonError, jsonResponse } from '../_shared/cors.ts';
import { avatarColorFor, isValidInviteCode, normalizeInviteCode, validateDisplayName } from '../_shared/validation.ts';

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== 'POST') return jsonError('Method not allowed.', 405);

  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) return jsonError('Unauthorized.', 401);

    const body = await readJsonBody<{ inviteCode?: unknown; displayName?: unknown }>(req);
    if (!body) return jsonError('Invalid JSON body.', 400);
    if (typeof body.inviteCode !== 'string' || !isValidInviteCode(body.inviteCode)) {
      return jsonError('Invalid invite code.', 400);
    }
    const nameError = validateDisplayName(body.displayName);
    if (nameError) return jsonError(nameError, 400);

    const code = normalizeInviteCode(body.inviteCode);
    const service = getServiceClient();

    const { data: room, error: roomError } = await service
      .from('meeting_rooms')
      .select('*')
      .eq('invite_code', code)
      .maybeSingle();
    if (roomError || !room) return jsonError('No meeting room found for that invite code.', 404);

    const roomRow = room as { id: string; status: string; expires_at: string };
    // Finalized rooms never count as expired (see COORDINATION.md):
    // a finalized room stays joinable for viewing/navigation even
    // after expires_at passes. Only open rooms expire by the clock.
    if (
      roomRow.status === 'expired' ||
      (roomRow.status !== 'finalized' && new Date(roomRow.expires_at).getTime() < Date.now())
    ) {
      // Expired links get a distinct 410 so the UI can explain clearly.
      // (This reveals that the code once existed; invite codes are
      // unguessable 6-char values, and the clear message is worth it —
      // see COORDINATION.md.) Missing codes still get the generic 404.
      return jsonError('This meeting link has expired.', 410, 'EXPIRED');
    }
    // Joining a FINALIZED room is allowed: the new member can view the
    // announcement and navigate, but cannot vote or change the outcome
    // (enforced by the state machine in the UI/services and by the
    // finalize-meeting guards). Joining never reopens a decision.

    // Idempotent: return the existing participant row for this user.
    const { data: existing } = await service
      .from('participants')
      .select('*')
      .eq('room_id', roomRow.id)
      .eq('auth_uid', userId)
      .maybeSingle();

    if (existing) {
      const { data: updated } = await service
        .from('participants')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', (existing as { id: string }).id)
        .select('*')
        .single();
      return jsonResponse({ room, participant: updated ?? existing, inviteCode: code });
    }

    const { data: participant, error: pError } = await service
      .from('participants')
      .insert({
        room_id: roomRow.id,
        auth_uid: userId,
        display_name: (body.displayName as string).trim(),
        avatar_color: avatarColorFor(userId),
        is_host: false,
        is_ready: false,
      })
      .select('*')
      .single();
    if (pError || !participant) {
      // Race: another request may have created the row (unique violation).
      const { data: raced } = await service
        .from('participants')
        .select('*')
        .eq('room_id', roomRow.id)
        .eq('auth_uid', userId)
        .maybeSingle();
      if (raced) return jsonResponse({ room, participant: raced, inviteCode: code });
      return jsonError('Failed to join room.', 500);
    }

    return jsonResponse({ room, participant, inviteCode: code });
  } catch {
    return jsonError('Internal error.', 500);
  }
});

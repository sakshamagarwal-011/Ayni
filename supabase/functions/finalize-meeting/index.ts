// finalize-meeting — host-only, with state-machine + optimistic-lock guards.
// Auth: Bearer JWT. Sets status='finalized' + finalized_spot_id +
// finalized_at and increments decision_version in ONE conditional update.
//
// Guards (all enforced server-side; the UI mirrors them):
// - Caller must be a room member (403 NOT_MEMBER) and the host (403 NOT_HOST).
// - Room must exist (404) and not be expired: status 'expired' or
//   expires_at in the past -> 410 EXPIRED.
// - Room must be in an open state (lobby/discovering/comparing).
//   Already finalized -> 409 ALREADY_FINALIZED naming the current spot.
// - Spot must belong to the room (400).
// - Optional expectedDecisionVersion: mismatch -> 409 STALE_VERSION
//   ("out of date — reload"). The update itself is conditional on the
//   current decision_version, so concurrent finalizes cannot both win:
//   a 0-row update -> 409 STALE_VERSION.
// Errors are typed JSON { error, code }; no stack traces.
import { getServiceClient, getUserIdFromRequest, readJsonBody } from '../_shared/auth.ts';
import { handleOptions, jsonError, jsonResponse } from '../_shared/cors.ts';
import { isUuid } from '../_shared/validation.ts';

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== 'POST') return jsonError('Method not allowed.', 405);

  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) return jsonError('Unauthorized.', 401, 'UNAUTHORIZED');

    const body = await readJsonBody<{ roomId?: unknown; spotId?: unknown; expectedDecisionVersion?: unknown }>(req);
    if (!body) return jsonError('Invalid JSON body.', 400);
    if (!isUuid(body.roomId)) return jsonError('Invalid room id.', 400);
    if (!isUuid(body.spotId)) return jsonError('Invalid spot id.', 400);
    const expectedVersion = body.expectedDecisionVersion;
    if (
      expectedVersion !== undefined &&
      expectedVersion !== null &&
      (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1)
    ) {
      return jsonError('Invalid decision version.', 400);
    }

    const service = getServiceClient();

    const { data: participant } = await service
      .from('participants')
      .select('id, is_host')
      .eq('room_id', body.roomId)
      .eq('auth_uid', userId)
      .maybeSingle();
    if (!participant) {
      return jsonError('You are not a member of this room.', 403, 'NOT_MEMBER');
    }
    if (!(participant as { is_host: boolean }).is_host) {
      return jsonError('Only the host can finalize the meeting.', 403, 'NOT_HOST');
    }

    const { data: roomRow } = await service
      .from('meeting_rooms')
      .select('id, status, expires_at, decision_version, finalized_spot_id')
      .eq('id', body.roomId)
      .maybeSingle();
    if (!roomRow) return jsonError('Room not found.', 404);
    const room = roomRow as {
      id: string;
      status: string;
      expires_at: string;
      decision_version: number;
      finalized_spot_id: string | null;
    };

    // Finalized rooms never count as expired (they must keep showing
    // the same destination), so the finalized check comes before the
    // wall-clock expiry check. Mirrors isRoomExpired() in the frontend.
    if (room.status === 'expired') {
      return jsonError('This meeting link has expired.', 410, 'EXPIRED');
    }
    if (room.status === 'finalized') {
      let spotName = 'the finalized spot';
      if (room.finalized_spot_id) {
        const { data: currentSpot } = await service
          .from('candidate_spots')
          .select('name')
          .eq('id', room.finalized_spot_id)
          .maybeSingle();
        if (currentSpot) spotName = (currentSpot as { name: string }).name;
      }
      return jsonError(`Meeting already finalized to ${spotName}.`, 409, 'ALREADY_FINALIZED');
    }
    if (new Date(room.expires_at).getTime() < Date.now()) {
      return jsonError('This meeting link has expired.', 410, 'EXPIRED');
    }
    if (room.status !== 'lobby' && room.status !== 'discovering' && room.status !== 'comparing') {
      return jsonError(`This meeting is ${room.status}, so it cannot be finalized.`, 409);
    }

    const { data: spot } = await service
      .from('candidate_spots')
      .select('id')
      .eq('id', body.spotId)
      .eq('room_id', body.roomId)
      .maybeSingle();
    if (!spot) return jsonError('That spot does not belong to this room.', 400);

    const currentVersion = room.decision_version ?? 1;
    if (typeof expectedVersion === 'number' && expectedVersion !== currentVersion) {
      return jsonError(
        'This decision is out of date — reload to see the latest room state.',
        409,
        'STALE_VERSION',
      );
    }

    // Optimistic lock: only one concurrent finalize can match the version.
    // The status predicate keeps a concurrent expire_rooms() from being
    // undone: if the room flipped to 'expired' after the checks above,
    // the update matches 0 rows and reports STALE_VERSION.
    const { data: updated, error } = await service
      .from('meeting_rooms')
      .update({
        status: 'finalized',
        finalized_spot_id: body.spotId,
        finalized_at: new Date().toISOString(),
        decision_version: currentVersion + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', body.roomId)
      .eq('decision_version', currentVersion)
      .in('status', ['lobby', 'discovering', 'comparing'])
      .select('*')
      .maybeSingle();
    if (error) return jsonError('Failed to finalize meeting.', 500);
    if (!updated) {
      return jsonError(
        'This decision is out of date — another finalize landed first. Reload to see the latest room state.',
        409,
        'STALE_VERSION',
      );
    }

    return jsonResponse({ room: updated });
  } catch {
    return jsonError('Internal error.', 500);
  }
});

// update-location — upserts the caller's OWN location in a room.
// Auth: Bearer JWT + membership check (participant lookup by room + auth_uid).
// Expiry is set to now + 2h here and re-enforced by the DB trigger.
import { getServiceClient, getUserIdFromRequest, readJsonBody } from '../_shared/auth.ts';
import { handleOptions, jsonError, jsonResponse } from '../_shared/cors.ts';
import { isUuid, validateAccuracyM, validateLatLng } from '../_shared/validation.ts';

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== 'POST') return jsonError('Method not allowed.', 405);

  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) return jsonError('Unauthorized.', 401);

    const body = await readJsonBody<{ roomId?: unknown; lat?: unknown; lng?: unknown; label?: unknown; accuracyM?: unknown }>(req);
    if (!body) return jsonError('Invalid JSON body.', 400);
    if (!isUuid(body.roomId)) return jsonError('Invalid room id.', 400);
    const locError = validateLatLng(body.lat, body.lng);
    if (locError) return jsonError(locError, 400);
    const acc = validateAccuracyM(body.accuracyM);
    if (acc.error) return jsonError(acc.error, 400);
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 60) : 'Starting point';

    const service = getServiceClient();

    const { data: participant, error: pError } = await service
      .from('participants')
      .select('id, room_id')
      .eq('room_id', body.roomId)
      .eq('auth_uid', userId)
      .maybeSingle();
    if (pError || !participant) return jsonError('You are not a participant in this room.', 403);

    const participantId = (participant as { id: string }).id;

    // Expired rooms reject location updates (finalized rooms allow them
    // for navigation). Mirrors the frontend state-machine rule.
    const { data: roomRow } = await service
      .from('meeting_rooms')
      .select('status, expires_at')
      .eq('id', body.roomId)
      .maybeSingle();
    const roomStatus = (roomRow as { status?: string } | null)?.status;
    const roomExpiresAt = (roomRow as { expires_at?: string } | null)?.expires_at;
    if (
      roomStatus === 'expired' ||
      (roomStatus !== 'finalized' && roomExpiresAt && new Date(roomExpiresAt).getTime() < Date.now())
    ) {
      return jsonError('This meeting link has expired.', 410, 'EXPIRED');
    }

    const now = new Date();
    const { data: location, error } = await service
      .from('participant_locations')
      .upsert(
        {
          participant_id: participantId,
          room_id: body.roomId,
          lat: body.lat,
          lng: body.lng,
          label,
          accuracy_m: acc.accuracyM,
          updated_at: now.toISOString(),
          expires_at: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        },
        { onConflict: 'participant_id' },
      )
      .select('*')
      .single();
    if (error || !location) return jsonError('Failed to update location.', 500);

    await service
      .from('participants')
      .update({ last_seen_at: now.toISOString() })
      .eq('id', participantId);

    return jsonResponse({ location });
  } catch {
    return jsonError('Internal error.', 500);
  }
});

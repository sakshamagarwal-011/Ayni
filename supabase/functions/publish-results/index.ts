// publish-results — publishes live engine results as votable candidate_spots.
// Auth: Bearer JWT (platform verify_jwt stays ON — no config.toml exception).
// Writes use the service-role client; browser clients cannot write
// candidate_spots directly (RLS), same as create-room seeding.
//
// Why this exists: the optimization engine finds real OSM places, but
// voting/finalizing operate on candidate_spots rows. Publishing turns
// the ranked top-5 into rows the whole room can vote on and finalize.
//
// Guards (all enforced server-side; the UI mirrors them):
// - Caller must be a room member (403 NOT_MEMBER).
// - Room must exist (404) and be open (lobby/discovering/comparing).
//   Finalized -> 409 ALREADY_FINALIZED; expired status or past
//   expires_at -> 410 EXPIRED (same order as finalize-meeting:
//   finalized rooms never count as expired).
// - Body: { roomId, places: 1-5 places }. Strict validation in
//   _shared/validation.ts: real OSM ids only, short name/category
//   labels, in-range coordinates. Rating/price/open-now are never
//   accepted — live places have none.
// - Spam cap: a room with >= 30 spots already cannot publish more
//   (409 SPOT_LIMIT). Re-publishing existing places does not grow the
//   count (dedup by OSM id), so the cap only bites on genuinely new
//   spots in an already-full room.
//
// Upsert strategy — select-then-write, NOT .upsert(onConflict):
// the dedup index is PARTIAL (WHERE osm_id IS NOT NULL), and Postgres
// only accepts a partial index as the ON CONFLICT arbiter when the
// query carries the matching WHERE predicate. The JS client's
// onConflict option cannot express that predicate, so .upsert would
// fail with "no unique or exclusion constraint matching". Instead
// this function selects the room's existing rows for the submitted
// OSM ids, updates those (keeping their ids — votes reference ids),
// and inserts the rest, retrying an insert exactly once through the
// unique-violation path (a concurrent publish of the same place).
// Re-publishing the same result set is idempotent: same rows, same
// ids, updated fields.
//
// Ordering vs finalization: the decision_version bump happens BEFORE
// the spot writes, conditional on the room still being open. If a
// finalize lands between the checks and the bump, the bump matches 0
// rows and the call fails STALE_VERSION without writing any spots.
// The bump itself is what propagates the new spots: meeting_rooms is
// in the Realtime publication, candidate_spots is not, so every open
// page refetches the full detail (including spots) on the room change
// event. See migration 0008.
//
// Errors are typed JSON { error, code }; no stack traces, no DB
// internals in responses.
import { getServiceClient, getUserIdFromRequest, readJsonBody } from '../_shared/auth.ts';
import { handleOptions, jsonError, jsonResponse } from '../_shared/cors.ts';
import { isUuid, validatePublishPlaces } from '../_shared/validation.ts';

/** Maximum candidate_spots per room. Seeded rooms start with 3; each publish adds at most 5. */
const MAX_SPOTS_PER_ROOM = 30;

const OPEN_STATUSES = ['lobby', 'discovering', 'comparing'];

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== 'POST') return jsonError('Method not allowed.', 405);

  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) return jsonError('Unauthorized.', 401, 'UNAUTHORIZED');

    const body = await readJsonBody<{ roomId?: unknown; places?: unknown }>(req);
    if (!body) return jsonError('Invalid JSON body.', 400);
    if (!isUuid(body.roomId)) return jsonError('Invalid room id.', 400);
    const validated = validatePublishPlaces(body.places);
    if (validated.error) return jsonError(validated.error, 400);
    const places = validated.places;
    const roomId = body.roomId as string;

    const service = getServiceClient();

    const { data: participant } = await service
      .from('participants')
      .select('id')
      .eq('room_id', roomId)
      .eq('auth_uid', userId)
      .maybeSingle();
    if (!participant) {
      return jsonError('You are not a member of this room.', 403, 'NOT_MEMBER');
    }

    const { data: roomRow } = await service
      .from('meeting_rooms')
      .select('id, status, expires_at, decision_version')
      .eq('id', roomId)
      .maybeSingle();
    if (!roomRow) return jsonError('Room not found.', 404);
    const room = roomRow as {
      id: string;
      status: string;
      expires_at: string;
      decision_version: number;
    };

    // Same guard order as finalize-meeting: finalized rooms never
    // count as expired, so the finalized check comes before the
    // wall-clock expiry check.
    if (room.status === 'expired') {
      return jsonError('This meeting link has expired.', 410, 'EXPIRED');
    }
    if (room.status === 'finalized') {
      return jsonError('This meeting is already finalized, so new spots cannot be published.', 409, 'ALREADY_FINALIZED');
    }
    if (new Date(room.expires_at).getTime() < Date.now()) {
      return jsonError('This meeting link has expired.', 410, 'EXPIRED');
    }
    if (!OPEN_STATUSES.includes(room.status)) {
      return jsonError(`This meeting is ${room.status}, so new spots cannot be published.`, 409);
    }

    // Spam/abuse cap, checked on the current total: re-publishing
    // existing places never grows the count (dedup below), so this
    // only rejects genuinely new spots in an already-full room.
    const { count: spotCount, error: countError } = await service
      .from('candidate_spots')
      .select('id', { count: 'exact', head: true })
      .eq('room_id', roomId);
    if (countError) return jsonError('Failed to publish places.', 500);
    if ((spotCount ?? 0) >= MAX_SPOTS_PER_ROOM) {
      return jsonError(
        `This room already has the maximum of ${MAX_SPOTS_PER_ROOM} spots.`,
        409,
        'SPOT_LIMIT',
      );
    }

    // Bump first, conditional on the room still being open: a
    // concurrent finalize makes this match 0 rows, and no spots are
    // written. The bump is also the propagation signal (see header).
    const currentVersion = room.decision_version ?? 1;
    const newVersion = currentVersion + 1;
    const { data: bumped, error: bumpError } = await service
      .from('meeting_rooms')
      .update({
        decision_version: newVersion,
        updated_at: new Date().toISOString(),
      })
      .eq('id', roomId)
      .in('status', OPEN_STATUSES)
      .select('id')
      .maybeSingle();
    if (bumpError) return jsonError('Failed to publish places.', 500);
    if (!bumped) {
      return jsonError(
        'This decision is out of date — the room changed. Reload to see the latest room state.',
        409,
        'STALE_VERSION',
      );
    }

    // Existing rows for the submitted OSM ids (dedup set, one query).
    const osmIds = places.map((p) => p.osmId);
    const { data: existingRows, error: selectError } = await service
      .from('candidate_spots')
      .select('*')
      .eq('room_id', roomId)
      .in('osm_id', osmIds);
    if (selectError) return jsonError('Failed to publish places.', 500);
    const existingByOsmId = new Map<string, Record<string, unknown>>();
    for (const row of (existingRows ?? []) as Record<string, unknown>[]) {
      if (typeof row['osm_id'] === 'string') existingByOsmId.set(row['osm_id'], row);
    }

    // rating/price_level/open_now are placeholders: live places have
    // no such data, and the frontend never renders them for
    // source='live' rows (see migration 0008). Never accept them
    // from the client.
    const published: Record<string, unknown>[] = [];
    for (const place of places) {
      const fields = {
        name: place.name,
        category: place.category,
        address: place.address,
        lat: place.lat,
        lng: place.lng,
        source: 'live',
      };
      const existing = existingByOsmId.get(place.osmId);
      if (existing) {
        const { data: updated, error: updateError } = await service
          .from('candidate_spots')
          .update(fields)
          .eq('id', existing['id'])
          .select('*')
          .single();
        if (updateError || !updated) {
          console.error('publish-results: spot update failed', updateError?.message);
          return jsonError('Failed to publish places.', 500);
        }
        published.push(updated as Record<string, unknown>);
        continue;
      }
      const { data: inserted, error: insertError } = await service
        .from('candidate_spots')
        .insert({
          ...fields,
          room_id: roomId,
          osm_id: place.osmId,
          rating: 0,
          price_level: 1,
          open_now: false,
        })
        .select('*')
        .single();
      if (!insertError && inserted) {
        published.push(inserted as Record<string, unknown>);
        continue;
      }
      // Unique violation (23505): a concurrent publish inserted the
      // same OSM place after our select. Re-select and update it so
      // the caller still gets the row, with its stable id.
      const code = (insertError as { code?: string } | null)?.code;
      if (code !== '23505') {
        console.error('publish-results: spot insert failed', insertError?.message);
        return jsonError('Failed to publish places.', 500);
      }
      const { data: raced, error: reselectError } = await service
        .from('candidate_spots')
        .select('*')
        .eq('room_id', roomId)
        .eq('osm_id', place.osmId)
        .maybeSingle();
      if (reselectError || !raced) return jsonError('Failed to publish places.', 500);
      const { data: updated, error: updateError } = await service
        .from('candidate_spots')
        .update(fields)
        .eq('id', (raced as Record<string, unknown>)['id'])
        .select('*')
        .single();
      if (updateError || !updated) {
        console.error('publish-results: raced spot update failed', updateError?.message);
        return jsonError('Failed to publish places.', 500);
      }
      published.push(updated as Record<string, unknown>);
    }

    return jsonResponse({ spots: published, decisionVersion: newVersion });
  } catch {
    return jsonError('Internal error.', 500);
  }
});

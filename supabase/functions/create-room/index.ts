// create-room — creates a meeting room + host participant + default spots.
// Auth: Bearer JWT (anonymous auth). Writes use the service-role client.
// Rate limiting: rely on Supabase Edge Function + Auth rate limits; add an
// upstream gateway limit for production use. See SUPABASE.md.
import { getServiceClient, getUserIdFromRequest, readJsonBody } from '../_shared/auth.ts';
import { handleOptions, jsonError, jsonResponse } from '../_shared/cors.ts';
import {
  avatarColorFor,
  generateInviteCode,
  validateDisplayName,
  validateLatLng,
  validateTitle,
} from '../_shared/validation.ts';

// Default candidate spots seeded server-side so a new room immediately has
// spots to compare. Same three Bengaluru spots as the demo data. Writes to
// candidate_spots are Edge-Function-only by RLS design, so seeding must
// happen here (not from the browser).
const DEFAULT_SPOTS = [
  {
    name: 'The Blue Bean Café',
    category: 'Café',
    address: '100 Ft Road, Indiranagar, Bengaluru',
    lat: 12.9698,
    lng: 77.641,
    rating: 4.6,
    price_level: 2,
    open_now: true,
    source: 'default',
  },
  {
    name: 'Violet Gardens Rooftop',
    category: 'Restaurant',
    address: 'Church Street, MG Road, Bengaluru',
    lat: 12.9753,
    lng: 77.6063,
    rating: 4.4,
    price_level: 3,
    open_now: true,
    source: 'default',
  },
  {
    name: 'Central Brew House',
    category: 'Brewery & Kitchen',
    address: 'Residency Road, Bengaluru',
    lat: 12.9605,
    lng: 77.6029,
    rating: 4.2,
    price_level: 2,
    open_now: false,
    source: 'default',
  },
];

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
    }>(req);
    if (!body) return jsonError('Invalid JSON body.', 400);

    const titleError = validateTitle(body.title);
    if (titleError) return jsonError(titleError, 400);
    const nameError = validateDisplayName(body.displayName);
    if (nameError) return jsonError(nameError, 400);
    const locError = validateLatLng(body.lat, body.lng);
    if (locError) return jsonError(locError, 400);
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
    if (!room) return jsonError(lastError ?? 'Failed to create room.', 500);

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
    await service.from('participant_locations').insert({
      participant_id: participantId,
      room_id: roomId,
      lat: body.lat,
      lng: body.lng,
      label,
      accuracy_m: 20,
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    });

    await service.from('candidate_spots').insert(DEFAULT_SPOTS.map((s) => ({ ...s, room_id: roomId })));

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

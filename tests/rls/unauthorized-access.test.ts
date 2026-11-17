/**
 * Unauthorized-access (RLS) tests.
 *
 * These tests run ONLY when test env vars are present. Without them they
 * skip gracefully with a clear message — `npm run test` (unit tests) never
 * depends on Supabase.
 *
 * Required to run:
 *   SUPABASE_URL, SUPABASE_ANON_KEY_TEST
 * Optional (enables member/non-member isolation checks against a real room):
 *   SUPABASE_SERVICE_ROLE_KEY  (test env ONLY — never commit it)
 *
 * Run:  SUPABASE_URL=... SUPABASE_ANON_KEY_TEST=... npm run test:rls
 * See TESTING.md for setup. Do NOT claim these passed without running them
 * against a real Supabase project.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY_TEST;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hasAnonConfig = Boolean(SUPABASE_URL && ANON_KEY);
const hasServiceKey = Boolean(SUPABASE_URL && SERVICE_KEY);

if (!hasAnonConfig) {
  console.warn(
    '[rls] Skipping unauthorized-access tests: SUPABASE_URL / SUPABASE_ANON_KEY_TEST not set. See TESTING.md.',
  );
}
if (hasAnonConfig && !hasServiceKey) {
  console.warn(
    '[rls] SUPABASE_SERVICE_ROLE_KEY not set: room-isolation tests will be skipped. Unauthenticated write tests still run.',
  );
}

const describeRls = hasAnonConfig ? describe : describe.skip;

describeRls('unauthorized access (RLS)', () => {
  let anonClient: SupabaseClient;
  let outsiderClient: SupabaseClient;
  let serviceClient: SupabaseClient | null = null;
  let testRoomId: string | null = null;
  let testParticipantId: string | null = null;
  let testSpotId: string | null = null;
  let outsiderUserId: string | null = null;

  beforeAll(async () => {
    anonClient = createClient(SUPABASE_URL!, ANON_KEY!);
    outsiderClient = createClient(SUPABASE_URL!, ANON_KEY!);
    if (hasServiceKey) {
      serviceClient = createClient(SUPABASE_URL!, SERVICE_KEY!);
      // Create a real room + participant via the service-role client so
      // isolation checks have something to (fail to) read.
      const code = `T${Math.random().toString(36).slice(2, 7).toUpperCase().replace(/[^A-Z2-9]/g, 'X')}`;
      const { data: room, error: roomError } = await serviceClient
        .from('meeting_rooms')
        .insert({ invite_code: code.slice(0, 6).padEnd(6, 'X'), title: 'RLS test room', status: 'lobby' })
        .select('id')
        .single();
      if (roomError || !room) throw new Error(`RLS setup failed to create room: ${roomError?.message}`);
      testRoomId = (room as { id: string }).id;
      const { data: participant, error: pError } = await serviceClient
        .from('participants')
        .insert({
          room_id: testRoomId,
          auth_uid: '00000000-0000-0000-0000-000000000001',
          display_name: 'RLS Owner',
          is_host: true,
        })
        .select('id')
        .single();
      if (pError || !participant) throw new Error(`RLS setup failed to create participant: ${pError?.message}`);
      testParticipantId = (participant as { id: string }).id;
      await serviceClient.from('participant_locations').insert({
        participant_id: testParticipantId,
        room_id: testRoomId,
        lat: 12.97,
        lng: 77.64,
        label: 'RLS location',
      });
      const { data: spot, error: spotError } = await serviceClient
        .from('candidate_spots')
        .insert({
          room_id: testRoomId,
          name: 'RLS Spot',
          category: 'cafe',
          address: 'RLS address',
          lat: 12.95,
          lng: 77.63,
          rating: 4.5,
          price_level: 2,
          open_now: true,
          source: 'mock',
        })
        .select('id')
        .single();
      if (spotError || !spot) throw new Error(`RLS setup failed to create spot: ${spotError?.message}`);
      testSpotId = (spot as { id: string }).id;
      const { error: voteError } = await serviceClient.from('votes').insert({
        room_id: testRoomId,
        participant_id: testParticipantId,
        spot_id: testSpotId,
        rank: 1,
      });
      if (voteError) throw new Error(`RLS setup failed to create vote: ${voteError.message}`);
      // Fresh anonymous user who is NOT a member of the test room.
      const { data: authData, error: authError } = await outsiderClient.auth.signInAnonymously();
      if (authError || !authData.user) {
        console.warn('[rls] Anonymous sign-in failed; outsider checks will run unauthenticated:', authError?.message);
      } else {
        outsiderUserId = authData.user.id;
      }
    }
  }, 30000);

  afterAll(async () => {
    if (serviceClient && testRoomId) {
      await serviceClient.from('meeting_rooms').delete().eq('id', testRoomId);
    }
    if (outsiderUserId) {
      await outsiderClient.auth.signOut().catch(() => undefined);
    }
  });

  it('unauthenticated SELECT on meeting_rooms by id returns no rows', async () => {
    const id = testRoomId ?? '00000000-0000-0000-0000-000000000000';
    const { data, error } = await anonClient.from('meeting_rooms').select('id').eq('id', id);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('unauthenticated direct INSERT into meeting_rooms fails', async () => {
    const { data, error } = await anonClient
      .from('meeting_rooms')
      .insert({ invite_code: 'ZZZZZZ', title: 'Attacker room', status: 'lobby' })
      .select('id');
    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('unauthenticated direct INSERT into participants fails', async () => {
    const { data, error } = await anonClient
      .from('participants')
      .insert({
        room_id: testRoomId ?? '00000000-0000-0000-0000-000000000000',
        auth_uid: '00000000-0000-0000-0000-000000000002',
        display_name: 'Attacker',
      })
      .select('id');
    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('unauthenticated direct INSERT into participant_locations fails', async () => {
    const { data, error } = await anonClient
      .from('participant_locations')
      .insert({
        participant_id: testParticipantId ?? '00000000-0000-0000-0000-000000000003',
        room_id: testRoomId ?? '00000000-0000-0000-0000-000000000000',
        lat: 0,
        lng: 0,
        label: 'Attacker',
      })
      .select('id');
    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it.skipIf(!hasServiceKey)('non-member cannot SELECT participant_locations', async () => {
    const { data, error } = await outsiderClient
      .from('participant_locations')
      .select('id')
      .eq('room_id', testRoomId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it.skipIf(!hasServiceKey)('non-member cannot UPDATE another participant', async () => {
    const { data, error } = await outsiderClient
      .from('participants')
      .update({ is_ready: true })
      .eq('id', testParticipantId!)
      .select('id');
    // RLS blocks the row: either an error or zero rows affected.
    if (error) {
      expect(error).not.toBeNull();
    } else {
      expect(data ?? []).toHaveLength(0);
    }
    // Verify the row was not actually changed (service-role read).
    const { data: after } = await serviceClient!
      .from('participants')
      .select('is_ready')
      .eq('id', testParticipantId!)
      .single();
    expect((after as { is_ready: boolean } | null)?.is_ready).toBe(false);
  });

  it.skipIf(!hasServiceKey)('non-member cannot SELECT the room by invite code', async () => {
    const { data: room } = await serviceClient!.from('meeting_rooms').select('invite_code').eq('id', testRoomId!).single();
    const code = (room as { invite_code: string }).invite_code;
    const { data, error } = await outsiderClient.from('meeting_rooms').select('id').eq('invite_code', code);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it.skipIf(!hasServiceKey)('non-member SELECT on votes returns empty', async () => {
    const { data, error } = await outsiderClient.from('votes').select('id').eq('room_id', testRoomId!);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it.skipIf(!hasServiceKey)('non-member cannot UPDATE participants.arrived_at', async () => {
    const { data, error } = await outsiderClient
      .from('participants')
      .update({ arrived_at: new Date().toISOString() })
      .eq('id', testParticipantId!)
      .select('id');
    if (error) {
      expect(error).not.toBeNull();
    } else {
      expect(data ?? []).toHaveLength(0);
    }
    const { data: after } = await serviceClient!
      .from('participants')
      .select('arrived_at')
      .eq('id', testParticipantId!)
      .single();
    expect((after as { arrived_at: string | null } | null)?.arrived_at).toBeNull();
  });

  it.skipIf(!hasServiceKey)('direct UPDATE of meeting_rooms status fails', async () => {
    const { data, error } = await outsiderClient
      .from('meeting_rooms')
      .update({ status: 'finalized', finalized_spot_id: testSpotId! })
      .eq('id', testRoomId!)
      .select('id');
    if (error) {
      expect(error).not.toBeNull();
    } else {
      expect(data ?? []).toHaveLength(0);
    }
    const { data: after } = await serviceClient!
      .from('meeting_rooms')
      .select('status, finalized_spot_id')
      .eq('id', testRoomId!)
      .single();
    expect((after as { status: string } | null)?.status).toBe('lobby');
    expect((after as { finalized_spot_id: string | null } | null)?.finalized_spot_id).toBeNull();
  });

  it.skipIf(!hasServiceKey)('direct INSERT of a vote for another participant fails', async () => {
    const { data, error } = await outsiderClient
      .from('votes')
      .insert({
        room_id: testRoomId!,
        participant_id: testParticipantId!,
        spot_id: testSpotId!,
        rank: 1,
      })
      .select('id');
    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
    const { data: after } = await serviceClient!.from('votes').select('id').eq('room_id', testRoomId!);
    expect(after ?? []).toHaveLength(1); // only the setup vote
  });
});

import { isSupabaseConfigured } from '../lib/supabaseClient';
import { MockRoomService } from './mockService';
import { SupabaseRoomService } from './supabaseService';
import type { RoomService } from './types';

let cached: RoomService | null = null;

/**
 * Service selection: Supabase when env vars are present, otherwise the
 * clearly-labelled Demo (mock) service. The UI only ever talks to the
 * RoomService interface, so switching backends changes no page code.
 */
export function getRoomService(): RoomService {
  if (cached) return cached;
  cached = isSupabaseConfigured() ? new SupabaseRoomService() : new MockRoomService();
  return cached;
}

export function getServiceMode(): 'demo' | 'supabase' {
  return isSupabaseConfigured() ? 'supabase' : 'demo';
}

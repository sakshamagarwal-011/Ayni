import type { Friend, MeetingSpot } from '../types';

/**
 * Mock data — Phase 1 demo only.
 * Exactly 4 friends and 3 meeting spots, all in Bengaluru.
 * No seed data is inserted by Supabase migrations; this file is the
 * only place demo seeding lives (plus an optional documented SQL
 * snippet in docs/seed-example.sql, never auto-applied).
 */
export const MOCK_FRIENDS: Friend[] = [
  {
    id: 'friend-aarav',
    name: 'Aarav Sharma',
    color: '#3B82F6',
    gradientClass: 'from-blue-500 to-cyan-400',
    area: 'Indiranagar',
    location: { lat: 12.9716, lng: 77.6412 },
  },
  {
    id: 'friend-priya',
    name: 'Priya Nair',
    color: '#8B5CF6',
    gradientClass: 'from-violet-500 to-fuchsia-400',
    area: 'Koramangala',
    location: { lat: 12.9352, lng: 77.6245 },
  },
  {
    id: 'friend-rohan',
    name: 'Rohan Patel',
    color: '#10B981',
    gradientClass: 'from-emerald-500 to-teal-400',
    area: 'HSR Layout',
    location: { lat: 12.9116, lng: 77.6474 },
  },
  {
    id: 'friend-ananya',
    name: 'Ananya Iyer',
    color: '#F59E0B',
    gradientClass: 'from-amber-500 to-orange-400',
    area: 'Whitefield',
    location: { lat: 12.9698, lng: 77.75 },
  },
];

export const MOCK_SPOTS: MeetingSpot[] = [
  {
    id: 'spot-blue-bean',
    name: 'The Blue Bean Café',
    category: 'Café',
    address: '100 Ft Road, Indiranagar, Bengaluru',
    location: { lat: 12.9698, lng: 77.641 },
    rating: 4.6,
    priceLevel: 2,
    openNow: true,
    source: 'mock',
  },
  {
    id: 'spot-violet-gardens',
    name: 'Violet Gardens Rooftop',
    category: 'Restaurant',
    address: 'Church Street, MG Road, Bengaluru',
    location: { lat: 12.9753, lng: 77.6063 },
    rating: 4.4,
    priceLevel: 3,
    openNow: true,
    source: 'mock',
  },
  {
    id: 'spot-central-brew',
    name: 'Central Brew House',
    category: 'Brewery & Kitchen',
    address: 'Residency Road, Bengaluru',
    location: { lat: 12.9605, lng: 77.6029 },
    rating: 4.2,
    priceLevel: 2,
    openNow: false,
    source: 'mock',
  },
];

export const AVATAR_COLORS = ['#3B82F6', '#8B5CF6', '#10B981', '#F59E0B', '#EC4899', '#06B6D4'];

export const DEMO_INVITE_CODE = 'K7M2QX';

/** Starting-area presets shown on Create / Join forms. */
export const STARTING_AREAS = MOCK_FRIENDS.map((f) => ({
  id: f.id,
  label: `${f.area} — ${f.name.split(' ')[0]}'s area`,
  area: f.area,
  location: f.location,
}));

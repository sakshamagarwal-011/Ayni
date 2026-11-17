import { describe, expect, it } from 'vitest';
import { isOptimizationStale } from '../../src/coordination/staleGuard';
import { signatureFromParticipants } from '../../src/engine/signature';
import type { OptimizationResult } from '../../src/engine/types';
import type { MeetingRoom, Participant } from '../../src/types';

const NOW = new Date('2026-11-17T18:00:00.000Z');
const LOC_UPDATED = '2026-11-17T17:30:00.000Z';
const LOC_EXPIRES = '2026-11-17T19:30:00.000Z';

function participant(id: string, updatedAt: string = LOC_UPDATED, expiresAt: string = LOC_EXPIRES): Participant {
  return {
    id,
    roomId: 'room-1',
    authUid: `auth-${id}`,
    displayName: id,
    avatarColor: '#fff',
    isHost: id === 'p1',
    isReady: false,
    arrivedAt: null,
    joinedAt: '2026-11-17T17:00:00.000Z',
    lastSeenAt: '2026-11-17T17:00:00.000Z',
    location: {
      id: `loc-${id}`,
      participantId: id,
      roomId: 'room-1',
      lat: 12.9,
      lng: 77.6,
      label: 'Somewhere',
      accuracyM: null,
      updatedAt,
      expiresAt,
    },
  };
}

function room(overrides: Partial<Pick<MeetingRoom, 'status' | 'expiresAt' | 'decisionVersion'>> = {}) {
  return {
    status: 'lobby' as const,
    expiresAt: '2026-11-18T00:00:00.000Z',
    decisionVersion: 1,
    ...overrides,
  };
}

function resultFor(participants: Participant[], decisionVersion: number | null = 1): OptimizationResult {
  return {
    decisionVersion,
    participantsSignature: signatureFromParticipants(participants),
    generatedAt: '2026-11-17T17:45:00.000Z',
  } as unknown as OptimizationResult;
}

describe('isOptimizationStale', () => {
  it('is fresh when nothing changed', () => {
    const participants = [participant('p1'), participant('p2')];
    expect(isOptimizationStale(resultFor(participants), room(), participants, NOW).stale).toBe(false);
  });
  it('is stale when the decision version changed', () => {
    const participants = [participant('p1'), participant('p2')];
    const check = isOptimizationStale(resultFor(participants, 1), room({ decisionVersion: 2 }), participants, NOW);
    expect(check.stale).toBe(true);
    expect(check.reason).toMatch(/newer decision/);
  });
  it('is stale when a participant joined', () => {
    const before = [participant('p1')];
    const after = [participant('p1'), participant('p2')];
    const check = isOptimizationStale(resultFor(before), room(), after, NOW);
    expect(check.stale).toBe(true);
    expect(check.reason).toMatch(/Participants or locations changed/);
  });
  it('is stale when a participant updated their location', () => {
    const before = [participant('p1')];
    const after = [participant('p1', '2026-11-17T17:50:00.000Z')];
    expect(isOptimizationStale(resultFor(before), room(), after, NOW).stale).toBe(true);
  });
  it('is stale when the room was finalized after the search', () => {
    const participants = [participant('p1')];
    const check = isOptimizationStale(resultFor(participants), room({ status: 'finalized' }), participants, NOW);
    expect(check.stale).toBe(true);
    expect(check.reason).toMatch(/finalized/);
  });
  it('is stale when the room expired after the search', () => {
    const participants = [participant('p1')];
    const check = isOptimizationStale(resultFor(participants), room({ status: 'expired' }), participants, NOW);
    expect(check.stale).toBe(true);
    const wallClock = isOptimizationStale(
      resultFor(participants),
      room({ expiresAt: '2026-11-17T17:00:00.000Z' }),
      participants,
      NOW,
    );
    expect(wallClock.stale).toBe(true);
  });
  it('is stale when a location expired after the search', () => {
    // Same signature (same updatedAt) but the location is now expired.
    const before = [participant('p1', LOC_UPDATED, '2026-11-17T17:59:00.000Z')];
    const check = isOptimizationStale(resultFor(before), room(), before, NOW);
    expect(check.stale).toBe(true);
    expect(check.reason).toMatch(/expired/);
  });
  it('treats a null decision version as stale (the version check cannot run)', () => {
    const participants = [participant('p1')];
    const check = isOptimizationStale(resultFor(participants, null), room({ decisionVersion: 5 }), participants, NOW);
    expect(check.stale).toBe(true);
    expect(check.reason).toMatch(/decision version/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  CoordinationError,
  coordinationErrorFromEdge,
  inferCoordinationCode,
  isCoordinationErrorCode,
  parseEdgeFunctionError,
  toCoordinationError,
} from '../../src/coordination/errors';

describe('CoordinationError', () => {
  it('carries a code and a user-safe message', () => {
    const error = new CoordinationError('NOT_HOST', 'Only the host can finalize the meeting.');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CoordinationError');
    expect(error.code).toBe('NOT_HOST');
    expect(error.userMessage).toBe('Only the host can finalize the meeting.');
    expect(error.message).toBe('Only the host can finalize the meeting.');
  });
});

describe('isCoordinationErrorCode', () => {
  it('accepts the eight documented codes', () => {
    for (const code of ['NOT_MEMBER', 'NOT_HOST', 'ALREADY_FINALIZED', 'STALE_VERSION', 'EXPIRED', 'OFFLINE', 'VOTE_FAILED', 'UNKNOWN']) {
      expect(isCoordinationErrorCode(code)).toBe(true);
    }
  });
  it('rejects anything else', () => {
    expect(isCoordinationErrorCode('NOPE')).toBe(false);
    expect(isCoordinationErrorCode(409)).toBe(false);
    expect(isCoordinationErrorCode(null)).toBe(false);
  });
});

describe('inferCoordinationCode', () => {
  it('maps messages to codes', () => {
    expect(inferCoordinationCode('This meeting link has expired.')).toBe('EXPIRED');
    expect(inferCoordinationCode('Meeting already finalized to Central Brew House.')).toBe('ALREADY_FINALIZED');
    expect(inferCoordinationCode('This decision is out of date.')).toBe('STALE_VERSION');
    expect(inferCoordinationCode('Only the host can finalize.')).toBe('NOT_HOST');
    expect(inferCoordinationCode('You are not a member of this room.')).toBe('NOT_MEMBER');
    expect(inferCoordinationCode('You are offline.')).toBe('OFFLINE');
    expect(inferCoordinationCode('Your ranking is empty.')).toBe('VOTE_FAILED');
    expect(inferCoordinationCode('Something odd happened.')).toBe('UNKNOWN');
  });
  it('falls back to HTTP status', () => {
    expect(inferCoordinationCode('boom', 410)).toBe('EXPIRED');
    // Bare 409/403 are ambiguous (STALE_VERSION vs ALREADY_FINALIZED,
    // NOT_HOST vs NOT_MEMBER) — Edge Functions send explicit codes.
    expect(inferCoordinationCode('boom', 409)).toBe('UNKNOWN');
    expect(inferCoordinationCode('boom', 403)).toBe('UNKNOWN');
    expect(inferCoordinationCode('boom', 401)).toBe('UNAUTHORIZED');
    expect(inferCoordinationCode('boom', 500)).toBe('UNKNOWN');
  });
  it('maps unauthorized messages and strict membership phrases only', () => {
    expect(inferCoordinationCode('Unauthorized.')).toBe('UNAUTHORIZED');
    expect(inferCoordinationCode('You must join this room before voting.')).toBe('NOT_MEMBER');
    // A bare "join" mention is not a membership error.
    expect(inferCoordinationCode('Failed to join the request.')).toBe('UNKNOWN');
  });
});

describe('toCoordinationError', () => {
  it('passes CoordinationError through unchanged', () => {
    const original = new CoordinationError('EXPIRED', 'Expired.');
    expect(toCoordinationError(original)).toBe(original);
  });
  it('wraps plain errors with an inferred code', () => {
    const wrapped = toCoordinationError(new Error('This meeting link has expired.'));
    expect(wrapped.code).toBe('EXPIRED');
    expect(wrapped.message).toBe('This meeting link has expired.');
  });
  it('uses the fallback for non-errors', () => {
    expect(toCoordinationError(null, 'Try again.').userMessage).toBe('Try again.');
    expect(toCoordinationError(undefined).code).toBe('UNKNOWN');
  });
});

describe('parseEdgeFunctionError', () => {
  it('parses a Response-like context with JSON { error, code }', async () => {
    const error = new Error('Edge Function returned a non-2xx status code');
    (error as unknown as { context: unknown }).context = {
      status: 409,
      json: async () => ({ error: 'This decision is out of date.', code: 'STALE_VERSION' }),
    };
    await expect(parseEdgeFunctionError(error)).resolves.toEqual({
      status: 409,
      message: 'This decision is out of date.',
      code: 'STALE_VERSION',
    });
  });
  it('falls back to the error message when there is no JSON body', async () => {
    await expect(parseEdgeFunctionError(new Error('network down'))).resolves.toEqual({
      status: undefined,
      message: 'network down',
    });
  });
  it('ignores an unknown server code', async () => {
    const error = new Error('Edge Function error');
    (error as unknown as { context: unknown }).context = {
      status: 500,
      json: async () => ({ error: 'Database unavailable.', code: 'SOMETHING_ELSE' }),
    };
    await expect(parseEdgeFunctionError(error)).resolves.toEqual({
      status: 500,
      message: 'Database unavailable.',
      code: undefined,
    });
  });
  it('never throws on malformed contexts', async () => {
    await expect(parseEdgeFunctionError({ context: { json: async () => { throw new Error('bad'); } } })).resolves.toEqual({
      message: undefined,
    });
  });
});

describe('coordinationErrorFromEdge', () => {
  it('prefers the explicit server code', () => {
    const error = coordinationErrorFromEdge(
      { status: 409, message: 'This decision is out of date.', code: 'STALE_VERSION' },
      'Failed.',
    );
    expect(error.code).toBe('STALE_VERSION');
    expect(error.message).toBe('This decision is out of date.');
  });
  it('infers from message/status and uses the fallback message when absent', () => {
    const error = coordinationErrorFromEdge({ status: 410 }, 'Failed to finalize.');
    expect(error.code).toBe('EXPIRED');
    expect(error.message).toBe('Failed to finalize.');
  });
});

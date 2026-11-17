/**
 * Typed coordination errors.
 *
 * Every coordination failure carries a stable `code` for branching and a
 * `userMessage` safe to show verbatim in the UI. `message` equals
 * `userMessage` so existing `catch (e) { e.message }` handling keeps
 * showing good text. No raw error objects or stack traces reach the UI.
 *
 * Error catalogue (see COORDINATION.md):
 * - NOT_MEMBER: caller is not a room member (or tried to act as someone else).
 * - NOT_HOST: action requires the host.
 * - ALREADY_FINALIZED: the meeting already has a finalized destination.
 * - STALE_VERSION: the decision version is out of date — reload and retry.
 * - EXPIRED: the room (or its invite link) has expired.
 * - OFFLINE: the device is offline / the live connection is down.
 * - VOTE_FAILED: the ranking was invalid or could not be saved.
 * - UNKNOWN: anything else; the message is still user-safe.
 */

export type CoordinationErrorCode =
  | 'NOT_MEMBER'
  | 'NOT_HOST'
  | 'ALREADY_FINALIZED'
  | 'STALE_VERSION'
  | 'EXPIRED'
  | 'OFFLINE'
  | 'VOTE_FAILED'
  | 'UNKNOWN';

const CODES: ReadonlySet<string> = new Set([
  'NOT_MEMBER',
  'NOT_HOST',
  'ALREADY_FINALIZED',
  'STALE_VERSION',
  'EXPIRED',
  'OFFLINE',
  'VOTE_FAILED',
  'UNKNOWN',
]);

export function isCoordinationErrorCode(value: unknown): value is CoordinationErrorCode {
  return typeof value === 'string' && CODES.has(value);
}

export class CoordinationError extends Error {
  readonly code: CoordinationErrorCode;
  readonly userMessage: string;

  constructor(code: CoordinationErrorCode, userMessage: string) {
    super(userMessage);
    this.name = 'CoordinationError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

/** Infer a code from a server/HTTP error message when no explicit code is present. */
export function inferCoordinationCode(message: string, status?: number): CoordinationErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes('expired') || lower.includes('expiry')) return 'EXPIRED';
  if (lower.includes('already finalized')) return 'ALREADY_FINALIZED';
  if (lower.includes('out of date') || lower.includes('stale') || lower.includes('decision version')) {
    return 'STALE_VERSION';
  }
  if (lower.includes('only the host')) return 'NOT_HOST';
  if (lower.includes('not a member') || lower.includes('not a participant') || lower.includes('join')) {
    return 'NOT_MEMBER';
  }
  if (lower.includes('offline')) return 'OFFLINE';
  if (lower.includes('vote') || lower.includes('ranking')) return 'VOTE_FAILED';
  if (status === 410) return 'EXPIRED';
  if (status === 409) return 'STALE_VERSION';
  if (status === 403) return 'NOT_HOST';
  if (status === 401) return 'NOT_MEMBER';
  return 'UNKNOWN';
}

/**
 * Normalize any thrown value into a CoordinationError, preserving an
 * explicit server code/message when present. Plain Error messages are
 * reused only when they are already user-safe (all service errors in
 * this codebase are written as user-facing messages).
 */
export function toCoordinationError(error: unknown, fallbackMessage?: string): CoordinationError {
  if (error instanceof CoordinationError) return error;
  if (error instanceof Error) {
    return new CoordinationError(inferCoordinationCode(error.message), error.message);
  }
  return new CoordinationError('UNKNOWN', fallbackMessage ?? 'Something went wrong. Try again.');
}

/**
 * Best-effort parse of a Supabase Edge Function invocation error.
 * `functions.invoke` surfaces non-2xx responses as an error whose
 * `context` is the Response; the Edge Functions return JSON
 * `{ error, code }`. Everything here is defensive: any parse failure
 * falls back to the error's own message.
 */
export async function parseEdgeFunctionError(error: unknown): Promise<{
  status?: number;
  message?: string;
  code?: CoordinationErrorCode;
}> {
  const fallbackMessage = error instanceof Error ? error.message : undefined;
  try {
    const context = (error as { context?: unknown } | null)?.context as
      | { status?: unknown; json?: unknown }
      | undefined;
    const status = typeof context?.status === 'number' ? context.status : undefined;
    if (context && typeof context.json === 'function') {
      const body = (await (context.json as () => Promise<unknown>)()) as {
        error?: unknown;
        code?: unknown;
      } | null;
      const message = typeof body?.error === 'string' ? body.error : fallbackMessage;
      const code = isCoordinationErrorCode(body?.code) ? body.code : undefined;
      return { status, message, code };
    }
    return { status, message: fallbackMessage };
  } catch {
    return { message: fallbackMessage };
  }
}

/** Build a CoordinationError from a parsed Edge Function failure. */
export function coordinationErrorFromEdge(
  parsed: { status?: number; message?: string; code?: CoordinationErrorCode },
  fallbackMessage: string,
): CoordinationError {
  const message = parsed.message ?? fallbackMessage;
  const code = parsed.code ?? inferCoordinationCode(message, parsed.status);
  return new CoordinationError(code, message);
}

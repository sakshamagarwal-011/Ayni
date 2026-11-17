/**
 * Typed engine errors. Callers must never receive an untyped string:
 * every failure carries a stable `code` for branching and a
 * `userMessage` safe to show verbatim in the UI.
 */

export type EngineErrorCode =
  | 'validation'
  | 'places_unavailable'
  | 'routing_unavailable'
  | 'no_places'
  | 'quota_exceeded'
  | 'engine_disabled';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly userMessage: string;

  constructor(code: EngineErrorCode, userMessage: string, detail?: string) {
    super(detail ?? userMessage);
    this.name = 'EngineError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

/** Input failed validation. `issues` lists every problem found (all of them, not just the first). */
export class OptimizationValidationError extends EngineError {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      'validation',
      `Cannot run the search: ${issues.join(' ')}`,
      `Optimization input invalid: ${issues.join(' | ')}`,
    );
    this.name = 'OptimizationValidationError';
    this.issues = issues;
  }
}

/** A live provider failed and no results may be shown as live results. */
export class EngineUnavailableError extends EngineError {
  constructor(provider: 'places' | 'routing', userMessage?: string) {
    super(
      provider === 'places' ? 'places_unavailable' : 'routing_unavailable',
      userMessage ??
        (provider === 'places'
          ? 'Live place search is unavailable — try again later. No estimates shown.'
          : 'Live routing is unavailable — try again later. No estimates shown.'),
    );
    this.name = 'EngineUnavailableError';
  }
}

/** Discovery succeeded but yielded no usable places. */
export class EngineNoPlacesError extends EngineError {
  constructor(categoryLabel: string, areaDescription: string) {
    super(
      'no_places',
      `No ${categoryLabel} places were found ${areaDescription}. Try a different category or a wider search area.`,
    );
    this.name = 'EngineNoPlacesError';
  }
}

/** The run would exceed the configured OSRM request budget. Never silently truncate. */
export class EngineQuotaError extends EngineError {
  constructor(pairs: number, budget: number) {
    super(
      'quota_exceeded',
      `This search would need ${pairs} route requests, over the limit of ${budget}. Reduce the number of candidates or participants and try again.`,
    );
    this.name = 'EngineQuotaError';
  }
}

/**
 * Engine barrel: the public surface of the optimization engine.
 * Pages import from here (or from the individual modules). The pure
 * core (types/errors/validation/searchAreas/scoring/ranking/places/
 * animation) has no fetch/window/Supabase imports; the impure layer
 * (placesClient/orchestrator/config) is clearly separated.
 */
export * from './types';
export * from './errors';
export * from './validation';
export * from './searchAreas';
export * from './scoring';
export * from './ranking';
export * from './places';
export * from './animation';
export * from './signature';
export * from './config';
export * from './placesClient';
export * from './orchestrator';

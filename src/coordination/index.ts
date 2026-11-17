/**
 * Coordination barrel: the public surface of the group-coordination
 * layer. Pure modules (state machine, voting, ETA, expiry, navigation,
 * arrival, stale guard, reconnect helper, errors) have no service
 * imports; pages and services import from here.
 */
export * from './errors';
export * from './stateMachine';
export * from './voting';
export * from './eta';
export * from './expiry';
export * from './navigation';
export * from './arrival';
export * from './staleGuard';
export * from './reconnect';

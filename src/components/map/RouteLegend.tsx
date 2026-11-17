import { formatDistance, formatDuration } from '../../lib/utils';
import { describeRouteSource } from '../../map/routing';
import type { RouteSource } from '../../types';

export interface LegendRoute {
  key: string;
  label: string;
  color: string;
  distanceM: number;
  durationMin: number;
  source: RouteSource;
  transitApproximation?: boolean;
}

/**
 * Text companion to the map's route lines: per-route distance/time plus
 * an honest source label. The same information is also in the page's
 * existing lists — the map never carries information alone.
 */
export function RouteLegend({
  routes,
  loading,
  demoMode,
  emptyText = 'No routes to show yet.',
}: {
  routes: LegendRoute[];
  loading?: boolean;
  demoMode?: boolean;
  emptyText?: string;
}) {
  const hasOsrm = routes.some((r) => r.source === 'osrm');
  const hasFallback = routes.some((r) => r.source === 'estimated');
  const allMock = routes.length > 0 && routes.every((r) => r.source === 'mock');

  return (
    <div className="glass-card p-4" aria-label="Route details">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-white">Routes</h3>
        {demoMode && (
          <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200">
            Demo data
          </span>
        )}
        {loading && <span className="text-xs text-slate-400">Loading routes…</span>}
      </div>
      {routes.length === 0 && !loading ? (
        <p className="mt-2 text-sm text-slate-300">{emptyText}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {routes.map((r) => (
            <li key={r.key} className="flex items-start justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2 text-slate-200">
                <span
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 rounded-full border border-white/40"
                  style={{ backgroundColor: r.color }}
                />
                <span className="truncate">{r.label}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className="font-medium text-white">
                  {formatDistance(r.distanceM)} · {formatDuration(r.durationMin)}
                </span>
                <span className="block text-[11px] text-slate-400">{describeRouteSource(r.source, r.transitApproximation)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-slate-400">
        {hasOsrm
          ? 'Road routes from OSRM (public development server — low volume only, no uptime guarantee). See MAPS.md for limits.'
          : hasFallback
            ? 'Some routes fell back to straight-line estimates because OSRM was unavailable. Distances are approximate.'
            : allMock
              ? 'Demo estimates use straight-line distance × 1.3 with average mode speeds — not road routes, no live traffic.'
              : 'Routes are estimates only — check live conditions before you leave.'}
      </p>
    </div>
  );
}

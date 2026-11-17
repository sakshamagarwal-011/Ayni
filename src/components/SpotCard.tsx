import { motion } from 'framer-motion';
import type { MeetingSpot } from '../types';
import { cn, priceLabel } from '../lib/utils';

export function SpotCard({
  spot,
  rank,
  selected,
  votes,
  footer,
  onSelect,
  badge,
}: {
  spot: MeetingSpot;
  rank?: number;
  selected?: boolean;
  votes?: number;
  footer?: React.ReactNode;
  onSelect?: () => void;
  badge?: string;
}) {
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        'glass-card p-4 sm:p-5',
        selected && 'border-violet-400/60 ring-2 ring-violet-500/40',
        onSelect && 'cursor-pointer transition hover:border-white/25',
      )}
      onClick={onSelect}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={onSelect ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } } : undefined}
      aria-label={spot.name}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {rank !== undefined && (
              <span className="rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-2.5 py-0.5 text-xs font-bold text-white">
                #{rank}
              </span>
            )}
            <span className="rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-xs text-slate-200">{spot.category}</span>
            {badge && <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-medium text-emerald-200">{badge}</span>}
          </div>
          <h3 className="mt-2 text-lg font-semibold text-white">{spot.name}</h3>
          <p className="text-sm text-slate-300">{spot.address}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold text-amber-300">★ {spot.rating.toFixed(1)}</p>
          <p className="text-xs text-slate-400">{priceLabel(spot.priceLevel)}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className={cn('rounded-full px-2.5 py-1 font-medium', spot.openNow ? 'bg-emerald-500/15 text-emerald-200' : 'bg-rose-500/15 text-rose-200')}>
          {spot.openNow ? 'Open now' : 'Closed now'}
        </span>
        {(spot.source === 'mock' || spot.source === 'default') && (
          <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 font-medium text-amber-200">
            Demo spot
          </span>
        )}
        {votes !== undefined && (
          <span className="rounded-full bg-white/5 px-2.5 py-1 text-slate-200">{votes} vote{votes === 1 ? '' : 's'}</span>
        )}
        <span className="text-slate-400">
          {spot.location.lat.toFixed(4)}, {spot.location.lng.toFixed(4)}
        </span>
      </div>
      {footer && <div className="mt-4 border-t border-white/10 pt-4">{footer}</div>}
    </motion.article>
  );
}

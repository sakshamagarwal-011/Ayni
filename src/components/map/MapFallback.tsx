/**
 * Placeholder shown while the MapLibre chunk loads (MeetingMap is
 * lazy-loaded so pages without a visible map don't pay for it).
 * Kept in its own module so importing it never pulls in maplibre-gl.
 */
export function MapFallback({ className = 'h-[320px] sm:h-[420px]' }: { className?: string }) {
  return (
    <div
      className={`flex items-center justify-center rounded-2xl border border-white/10 bg-navy-900 ${className}`}
      role="status"
      aria-label="Map loading"
    >
      <span className="inline-flex items-center gap-2 text-sm text-slate-300">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-violet-400" />
        Loading map…
      </span>
    </div>
  );
}

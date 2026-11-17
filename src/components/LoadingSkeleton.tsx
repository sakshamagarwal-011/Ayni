export function LoadingSkeleton({ lines = 3, label = 'Loading…' }: { lines?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
      ))}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" aria-label={label} className="inline-flex items-center gap-2 text-sm text-slate-300">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-violet-400" />
      {label}…
    </span>
  );
}

export function PageSkeleton({ title }: { title: string }) {
  return (
    <div className="space-y-4">
      <div className="h-8 w-56 animate-pulse rounded-lg bg-white/10" />
      <p className="sr-only">{title} loading</p>
      <LoadingSkeleton lines={4} label={`${title} loading`} />
    </div>
  );
}

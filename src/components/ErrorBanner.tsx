import { Link } from 'react-router-dom';
import { cn } from '../lib/utils';

export function ErrorBanner({
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Try again',
  showJoinLink = false,
  joinCode,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  showJoinLink?: boolean;
  /** Invite code preserved by the Join link (dropping it strands the user at an empty Join form). */
  joinCode?: string;
}) {
  return (
    <div role="alert" className="glass-card border-rose-500/30 bg-rose-500/10 p-4 sm:p-5">
      <p className="font-semibold text-rose-100">{title}</p>
      <p className="mt-1 text-sm text-rose-200/90">{message}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {onRetry && (
          <button type="button" onClick={onRetry} className="btn-secondary !px-4 !py-2 text-xs">
            {retryLabel}
          </button>
        )}
        {showJoinLink && (
          <Link to={joinCode ? `/join/${joinCode}` : '/join'} className="btn-secondary !px-4 !py-2 text-xs">
            Go to Join Meeting
          </Link>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) {
  return (
    <div className={cn('glass-card p-6 text-center')}>
      <p className="font-semibold text-white">{title}</p>
      <p className="mt-1 text-sm text-slate-300">{description}</p>
      {children && <div className="mt-4 flex justify-center gap-2">{children}</div>}
    </div>
  );
}

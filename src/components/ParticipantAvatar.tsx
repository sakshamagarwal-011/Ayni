import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { initials } from '../lib/utils';

export function ParticipantAvatar({
  name,
  color,
  size = 'md',
  isReady,
}: {
  name: string;
  color: string;
  size?: 'sm' | 'md' | 'lg';
  isReady?: boolean;
}) {
  const sizeClass = size === 'sm' ? 'h-8 w-8 text-xs' : size === 'lg' ? 'h-14 w-14 text-base' : 'h-11 w-11 text-sm';
  return (
    <span className="relative inline-flex shrink-0" aria-label={name}>
      <span
        className={cn('inline-flex items-center justify-center rounded-full font-bold text-white', sizeClass)}
        style={{ backgroundColor: color }}
      >
        {initials(name)}
      </span>
      {isReady !== undefined && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-navy-950',
            isReady ? 'bg-emerald-400' : 'bg-slate-500',
          )}
          aria-label={isReady ? 'Ready' : 'Not ready'}
        />
      )}
    </span>
  );
}

export function AvatarStack({ children }: { children: ReactNode }) {
  return <div className="flex -space-x-2">{children}</div>;
}

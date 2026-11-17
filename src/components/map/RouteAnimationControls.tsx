import type { AnimationSpeed, RouteAnimationState } from './useRouteAnimation';

/**
 * Playback + visibility controls for animated routes. Presentation
 * only: all state lives in useRouteAnimation, and no routing or
 * places call is made from here.
 *
 * Mobile-friendly: 44px+ touch targets, wrapping chips, full-width
 * progress slider with keyboard support.
 */

export interface AnimationParticipantChip {
  id: string;
  name: string;
  color: string;
}

export function RouteAnimationControls({
  animation,
  participants,
  immersiveSupported,
  immersiveReason,
  sourceLabel,
}: {
  animation: RouteAnimationState;
  participants: AnimationParticipantChip[];
  immersiveSupported: boolean;
  immersiveReason: string;
  sourceLabel: string;
}) {
  const { progress, playing, speed } = animation;
  return (
    <div className="glass-card space-y-3 p-4" aria-label="Route animation controls">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-white">Route playback</h3>
        <span className="text-xs text-slate-400">{sourceLabel}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={playing ? animation.pause : animation.play}
          aria-label={playing ? 'Pause route animation' : 'Play route animation'}
          className="btn-primary min-h-[44px] !px-5 !py-2.5 text-sm"
        >
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button
          type="button"
          onClick={animation.replay}
          aria-label="Replay route animation from the start"
          className="btn-secondary min-h-[44px] !px-5 !py-2.5 text-sm"
        >
          ↺ Replay
        </button>
        <div className="flex gap-1 rounded-xl bg-white/5 p-1" role="group" aria-label="Playback speed">
          {([1, 2] as AnimationSpeed[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => animation.setSpeed(s)}
              aria-pressed={speed === s}
              className={`min-h-[44px] rounded-lg px-4 text-sm font-medium ${
                speed === s ? 'bg-violet-600 text-white' : 'text-slate-300 hover:bg-white/10'
              }`}
            >
              {s}×
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => animation.setImmersive3D(!animation.immersive3D)}
          disabled={!immersiveSupported}
          aria-pressed={animation.immersive3D}
          title={immersiveSupported ? 'Immersive 3D view (pitched camera + buildings)' : immersiveReason}
          className={`min-h-[44px] rounded-xl border px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
            animation.immersive3D
              ? 'border-violet-400/60 bg-violet-600 text-white'
              : 'border-white/15 bg-white/5 text-slate-200 hover:bg-white/10'
          }`}
        >
          Immersive 3D {animation.immersive3D ? '· on' : '· off'}
        </button>
      </div>
      {!immersiveSupported && (
        <p className="text-xs text-slate-400" role="status">
          {immersiveReason} Showing the 2D map.
        </p>
      )}
      {animation.reducedMotion && (
        <p className="text-xs text-slate-400" role="status">
          Reduced motion is on, so routes are shown in full and playback starts paused. Press Play to animate.
        </p>
      )}

      <div>
        <label htmlFor="route-animation-progress" className="label">
          Animation progress — {Math.round(progress * 100)}%
        </label>
        <input
          id="route-animation-progress"
          type="range"
          min={0}
          max={100}
          value={Math.round(progress * 100)}
          onChange={(e) => animation.seek(Number(e.target.value) / 100)}
          aria-valuetext={`${Math.round(progress * 100)} percent`}
          className="w-full accent-violet-500"
        />
      </div>

      <div>
        <p className="label">Show routes for</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Participant route visibility">
          {participants.map((p) => {
            const visible = animation.visibleIds.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => animation.toggleVisibility(p.id)}
                aria-pressed={visible}
                aria-label={`${visible ? 'Hide' : 'Show'} ${p.name}'s route`}
                className={`flex min-h-[44px] items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium ${
                  visible
                    ? 'border-white/25 bg-white/10 text-white'
                    : 'border-white/10 bg-white/[0.02] text-slate-400'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="h-3 w-3 rounded-full border border-white/40"
                  style={{ backgroundColor: p.color, opacity: visible ? 1 : 0.35 }}
                />
                {p.name}
                <span aria-hidden="true" className="text-xs">
                  {visible ? '👁' : '🚫'}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

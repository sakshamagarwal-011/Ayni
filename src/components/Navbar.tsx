import { Link, NavLink } from 'react-router-dom';
import { getServiceMode } from '../services';

export function Navbar() {
  const mode = getServiceMode();
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-navy-950/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link to="/" className="flex items-center gap-2" aria-label="MeetSync 3D home">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 text-lg font-bold text-white">
            M
          </span>
          <span className="text-base font-bold tracking-tight text-white sm:text-lg">
            MeetSync <span className="bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-transparent">3D</span>
          </span>
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2" aria-label="Primary">
          <NavLink to="/create" className={({ isActive }) => `rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-white/10 text-white' : 'text-slate-300 hover:text-white'}`}>
            Create
          </NavLink>
          <NavLink to="/join" className={({ isActive }) => `rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-white/10 text-white' : 'text-slate-300 hover:text-white'}`}>
            Join
          </NavLink>
          {mode === 'demo' ? (
            <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-200" title="Supabase env vars not set — using local demo data. See SUPABASE.md to connect.">
              Demo mode — Supabase not configured
            </span>
          ) : (
            <span className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-200">
              Live · Supabase
            </span>
          )}
        </nav>
      </div>
    </header>
  );
}

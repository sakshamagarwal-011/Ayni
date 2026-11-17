import { useEffect } from 'react';
import { motion, useAnimationControls } from 'framer-motion';
import { Outlet, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './ErrorBoundary';
import { Navbar } from './Navbar';

export function Layout() {
  const location = useLocation();
  const controls = useAnimationControls();

  // Replay the page-enter animation on navigation WITHOUT remounting
  // the page: the previous key={location.pathname} remounted the whole
  // page tree on every navigation, losing unsaved ranking drafts and
  // resetting mode/spot selection. The animation itself is identical
  // (0.25s easeOut fade + slide from y:10).
  useEffect(() => {
    void controls.start({
      opacity: [0, 1],
      y: [10, 0],
      transition: { duration: 0.25, ease: 'easeOut' },
    });
  }, [location.pathname, controls]);

  return (
    <div className="flex min-h-dvh flex-col bg-navy-950 text-slate-100">
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-32 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-blue-600/20 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-72 w-72 rounded-full bg-violet-600/20 blur-3xl" />
      </div>
      <Navbar />
      <motion.main
        initial={{ opacity: 0, y: 10 }}
        animate={controls}
        className="relative mx-auto w-full max-w-5xl flex-1 px-4 pb-16 pt-6 sm:px-6 sm:pt-8"
        style={{ paddingBottom: 'max(4rem, env(safe-area-inset-bottom))' }}
      >
        {/* Error boundary around the page outlet only: the navbar,
            footer, and background survive a page crash, and the
            boundary resets when the pathname changes (see
            ErrorBoundary), so navigating away never traps the user
            on the fallback. Deliberately NOT keyed: remounting the
            page tree on navigation would lose unsaved state. */}
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </motion.main>
      <footer className="relative border-t border-white/10 py-4 text-center text-xs text-slate-400">
        Ayni · A little from everyone · Maps: MapLibre + © OpenStreetMap contributors · Routes: OSRM (development) or demo estimates
      </footer>
    </div>
  );
}

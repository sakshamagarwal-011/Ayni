import { motion } from 'framer-motion';
import { Outlet, useLocation } from 'react-router-dom';
import { Navbar } from './Navbar';

export function Layout() {
  const location = useLocation();
  return (
    <div className="flex min-h-dvh flex-col bg-navy-950 text-slate-100">
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-32 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-blue-600/20 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-72 w-72 rounded-full bg-violet-600/20 blur-3xl" />
      </div>
      <Navbar />
      <motion.main
        key={location.pathname}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="relative mx-auto w-full max-w-5xl flex-1 px-4 pb-16 pt-6 sm:px-6 sm:pt-8"
        style={{ paddingBottom: 'max(4rem, env(safe-area-inset-bottom))' }}
      >
        <Outlet />
      </motion.main>
      <footer className="relative border-t border-white/10 py-4 text-center text-xs text-slate-400">
        MeetSync 3D · Maps: MapLibre + © OpenStreetMap contributors · Routes: OSRM (development) or demo estimates
      </footer>
    </div>
  );
}

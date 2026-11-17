import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { MOCK_FRIENDS, MOCK_SPOTS, DEMO_INVITE_CODE } from '../data/mockData';
import { ParticipantAvatar } from '../components/ParticipantAvatar';
import { SpotCard } from '../components/SpotCard';
import { getServiceMode } from '../services';

export function Landing() {
  const mode = getServiceMode();
  return (
    <div className="space-y-10">
      <section className="pt-4 text-center sm:pt-8">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <p className="text-xs font-semibold uppercase tracking-widest text-violet-300">Group meeting point finder</p>
          <h1 className="mx-auto mt-3 max-w-2xl text-4xl font-extrabold leading-tight text-white sm:text-5xl">
            Find the spot that works for{' '}
            <span className="bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-transparent">everyone</span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base text-slate-300">
            Share a link, drop your starting points, compare fair meeting spots, vote, and navigate together — no
            endless group-chat debates.
          </p>
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <Link to="/create" className="btn-primary">
              Create a meeting
            </Link>
            <Link to="/join" className="btn-secondary">
              Join with a code
            </Link>
          </div>
          <p className="mt-4 text-xs text-slate-400">
            {mode === 'demo' ? (
              <>
                Demo mode: try the sample room with code{' '}
                <Link to={`/join/${DEMO_INVITE_CODE}`} className="font-mono font-semibold text-blue-300 underline">
                  {DEMO_INVITE_CODE}
                </Link>
              </>
            ) : (
              'Live mode: rooms sync across browsers and devices via Supabase.'
            )}
          </p>
        </motion.div>
      </section>

      <section aria-label="How it works" className="grid gap-3 sm:grid-cols-3">
        {[
          { step: '1', title: 'Create & share', text: 'Start a room, get a 6-character invite code and link.' },
          { step: '2', title: 'Compare fairly', text: 'See travel time for every friend to every spot.' },
          { step: '3', title: 'Vote & navigate', text: 'Rank spots, finalise one, and head there together.' },
        ].map((s) => (
          <div key={s.step} className="glass-card p-5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-r from-blue-600 to-violet-600 text-sm font-bold text-white">
              {s.step}
            </span>
            <h2 className="mt-3 font-semibold text-white">{s.title}</h2>
            <p className="mt-1 text-sm text-slate-300">{s.text}</p>
          </div>
        ))}
      </section>

      <section aria-label="Preview">
        <h2 className="text-lg font-semibold text-white">A look at a Bengaluru meetup</h2>
        <p className="mt-1 text-sm text-slate-300">Four friends, three spots — travel estimates are calculated, not guessed.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          {MOCK_FRIENDS.map((f) => (
            <div key={f.id} className="glass-card flex items-center gap-3 px-4 py-3">
              <ParticipantAvatar name={f.name} color={f.color} />
              <div>
                <p className="text-sm font-semibold text-white">{f.name}</p>
                <p className="text-xs text-slate-400">{f.area}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {MOCK_SPOTS.map((spot) => (
            <SpotCard key={spot.id} spot={spot} />
          ))}
        </div>
      </section>
    </div>
  );
}

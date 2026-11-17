import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { LocationPicker, type LocationValue } from '../components/LocationPicker';
import { ErrorBanner } from '../components/ErrorBanner';
import { Spinner } from '../components/LoadingSkeleton';
import { STARTING_AREAS } from '../data/mockData';
import { getDisplayNameDraft } from '../services/mockService';
import { getRoomService } from '../services';
import { normalizeInviteCode, validateDisplayName, validateInviteCode, validateLocation } from '../lib/validation';

export function JoinMeeting() {
  const { code: codeParam } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [code, setCode] = useState(codeParam ?? '');
  const [displayName, setDisplayName] = useState(() => getDisplayNameDraft());
  const [location, setLocation] = useState<LocationValue>({
    location: STARTING_AREAS[1].location,
    label: STARTING_AREAS[1].area,
  });
  const [errors, setErrors] = useState<{ code?: string; name?: string; location?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (codeParam) setCode(codeParam);
  }, [codeParam]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    const next = {
      code: validateInviteCode(code) ?? undefined,
      name: validateDisplayName(displayName) ?? undefined,
      location: validateLocation(location.location.lat, location.location.lng, location.label) ?? undefined,
    };
    setErrors(next);
    if (next.code || next.name || next.location) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const detail = await getRoomService().joinRoom({
        inviteCode: normalizeInviteCode(code),
        displayName: displayName.trim(),
        location: location.location,
        locationLabel: location.label,
      });
      navigate(`/room/${detail.room.inviteCode}/lobby`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to join the meeting.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white sm:text-3xl">Join a meeting</h1>
        <p className="mt-1 text-sm text-slate-300">
          Enter the 6-character invite code from the link your friend shared. The same link works in any browser or on
          another device.
        </p>
      </div>

      {submitError && <ErrorBanner title="Could not join" message={submitError} />}

      <form onSubmit={handleSubmit} noValidate className="glass-card space-y-5 p-5 sm:p-6">
        <div>
          <label htmlFor="code" className="label">
            Invite code
          </label>
          <input
            id="code"
            className="input-field font-mono uppercase tracking-widest"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="e.g. K7M2QX"
            maxLength={8}
            aria-invalid={Boolean(touched && errors.code)}
            aria-describedby="code-error"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
          {touched && errors.code && (
            <p id="code-error" role="alert" className="field-error">
              {errors.code}
            </p>
          )}
          <p className="mt-1 text-xs text-slate-400">Dashes and spaces are ignored. Codes never contain 0/O or 1/I.</p>
        </div>

        <div>
          <label htmlFor="joinName" className="label">
            Your display name
          </label>
          <input
            id="joinName"
            className="input-field"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Alex"
            maxLength={30}
            aria-invalid={Boolean(touched && errors.name)}
            aria-describedby="join-name-error"
            autoComplete="nickname"
          />
          {touched && errors.name && (
            <p id="join-name-error" role="alert" className="field-error">
              {errors.name}
            </p>
          )}
        </div>

        <LocationPicker value={location} onChange={setLocation} error={touched ? errors.location : null} />

        <button type="submit" className="btn-primary w-full" disabled={submitting}>
          {submitting ? <Spinner label="Joining" /> : 'Join meeting'}
        </button>
      </form>
    </div>
  );
}

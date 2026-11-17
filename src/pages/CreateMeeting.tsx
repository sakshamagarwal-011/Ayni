import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LocationPicker, type LocationValue } from '../components/LocationPicker';
import { ErrorBanner } from '../components/ErrorBanner';
import { Spinner } from '../components/LoadingSkeleton';
import { STARTING_AREAS } from '../data/mockData';
import { getDisplayNameDraft } from '../services/mockService';
import { getRoomService } from '../services';
import { validateDisplayName, validateLocation, validateTitle } from '../lib/validation';

export function CreateMeeting() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [displayName, setDisplayName] = useState(() => getDisplayNameDraft());
  const [location, setLocation] = useState<LocationValue>({
    location: STARTING_AREAS[0].location,
    label: STARTING_AREAS[0].area,
  });
  const [errors, setErrors] = useState<{ title?: string; name?: string; location?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    const next = {
      title: validateTitle(title) ?? undefined,
      name: validateDisplayName(displayName) ?? undefined,
      location: validateLocation(location.location.lat, location.location.lng, location.label) ?? undefined,
    };
    setErrors(next);
    if (next.title || next.name || next.location) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const detail = await getRoomService().createRoom({
        title: title.trim(),
        displayName: displayName.trim(),
        location: location.location,
        locationLabel: location.label,
      });
      navigate(`/room/${detail.room.inviteCode}/lobby`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create the meeting.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white sm:text-3xl">Create a meeting</h1>
        <p className="mt-1 text-sm text-slate-300">You will get a shareable invite code and link for your friends.</p>
      </div>

      {submitError && <ErrorBanner message={submitError} />}

      <form onSubmit={handleSubmit} noValidate className="glass-card space-y-5 p-5 sm:p-6">
        <div>
          <label htmlFor="title" className="label">
            Meeting title
          </label>
          <input
            id="title"
            className="input-field"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="e.g. Weekend brunch meetup"
            maxLength={60}
            aria-invalid={Boolean(touched && errors.title)}
            aria-describedby="title-error"
            autoComplete="off"
          />
          {touched && errors.title && (
            <p id="title-error" role="alert" className="field-error">
              {errors.title}
            </p>
          )}
          <p className="mt-1 text-xs text-slate-400">{title.trim().length}/60 characters · minimum 3</p>
        </div>

        <div>
          <label htmlFor="displayName" className="label">
            Your display name
          </label>
          <input
            id="displayName"
            className="input-field"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Alex"
            maxLength={30}
            aria-invalid={Boolean(touched && errors.name)}
            aria-describedby="name-error"
            autoComplete="nickname"
          />
          {touched && errors.name && (
            <p id="name-error" role="alert" className="field-error">
              {errors.name}
            </p>
          )}
        </div>

        <LocationPicker value={location} onChange={setLocation} error={touched ? errors.location : null} />

        <button type="submit" className="btn-primary w-full" disabled={submitting}>
          {submitting ? <Spinner label="Creating meeting" /> : 'Create meeting & get invite link'}
        </button>
        <p className="text-center text-xs text-slate-400">
          Your location is only shared with people in this room and expires after 2 hours.
        </p>
      </form>
    </div>
  );
}

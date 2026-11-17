import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * Safety net for render-time crashes (v0.7.4).
 *
 * If a page throws while rendering — including a lazy chunk-load
 * failure — the boundary shows a plain-words fallback with a reload
 * button instead of a blank screen. The error is logged to
 * console.error only; nothing leaves the device (no error-reporting
 * service).
 *
 * Coverage: render-time errors in the wrapped tree only. Event-handler
 * and async errors are NOT caught here — those already have their own
 * handling (service fallbacks, reconnect, retry UI). No
 * window.onerror / unhandledrejection handlers are added.
 *
 * The error state resets when `resetKey` changes (the layout passes
 * the current pathname), so navigating away from a crashed page — via
 * the navbar, which sits outside the boundary — gives the next page a
 * clean render instead of trapping the user on the fallback. Resetting
 * via getDerivedStateFromProps deliberately avoids keying/remounting:
 * remounting the page tree on navigation would lose unsaved state
 * (see the animation comment in Layout.tsx).
 */
export class ErrorBoundary extends Component<
  { children?: ReactNode; resetKey: string },
  { error: Error | null; resetKey: string }
> {
  constructor(props: { children?: ReactNode; resetKey: string }) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { children?: ReactNode; resetKey: string },
    state: { error: Error | null; resetKey: string },
  ): { error: null; resetKey: string } | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Ayni: a page failed to render.', error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.error) {
      // Fallback mirrors the ErrorBanner card/button classes — no new
      // design; this UI appears only when a page has crashed.
      return (
        <div role="alert" className="glass-card border-rose-500/30 bg-rose-500/10 p-4 sm:p-5">
          <p className="font-semibold text-rose-100">Something went wrong</p>
          <p className="mt-1 text-sm text-rose-200/90">
            This page ran into a problem and couldn&rsquo;t load. Reloading usually fixes it.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => window.location.reload()} className="btn-secondary !px-4 !py-2 text-xs">
              Reload the page
            </button>
            <Link to="/" className="btn-secondary !px-4 !py-2 text-xs">
              Back to home
            </Link>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

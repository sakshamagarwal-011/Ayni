/* @vitest-environment jsdom */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';

// Tell React this environment supports act() (no setup file exists).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// No JSX in this file on purpose: vitest only includes *.test.ts, so
// the boundary is exercised with createElement. A real DOM render is
// required: the server renderers cannot exercise an error boundary
// (renderToString rethrows; the streaming renderer reports the caught
// error as a shell failure), so this file runs under jsdom — the only
// dev-only dependency added for v0.7.4. The fallback contains a
// <Link>, so renders run inside a MemoryRouter.

const mounted: { root: Root; container: HTMLElement }[] = [];

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  vi.restoreAllMocks();
});

function renderInRouter(node: ReactNode): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(createElement(MemoryRouter, null, node));
  });
  return { container, root };
}

function ThrowingChild(): ReactNode {
  throw new Error('boom');
}

function HealthyChild(): ReactNode {
  return createElement('p', null, 'Healthy content');
}

/** React logs boundary-caught errors to console.error in dev; silence it. */
function silenceConsoleError(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('ErrorBoundary rendering', () => {
  it('renders a healthy child normally, with no fallback', () => {
    const { container } = renderInRouter(
      createElement(ErrorBoundary, { resetKey: '/' }, createElement(HealthyChild)),
    );
    expect(container.textContent).toContain('Healthy content');
    expect(container.textContent).not.toContain('Something went wrong');
  });

  it('shows the fallback (not a blank render) when a child throws', () => {
    silenceConsoleError();
    const { container } = renderInRouter(
      createElement(ErrorBoundary, { resetKey: '/' }, createElement(ThrowingChild)),
    );
    expect(container.textContent).toContain('Something went wrong');
    expect(container.textContent).toContain('Reload the page');
    expect(container.textContent).toContain('Back to home');
    expect(container.querySelector('a[href="/"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('recovers when the route key changes after a crash', () => {
    silenceConsoleError();
    const { container, root } = renderInRouter(
      createElement(ErrorBoundary, { resetKey: '/room/ABC/lobby' }, createElement(ThrowingChild)),
    );
    expect(container.textContent).toContain('Something went wrong');
    act(() => {
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(ErrorBoundary, { resetKey: '/room/ABC/routes' }, createElement(HealthyChild)),
        ),
      );
    });
    expect(container.textContent).toContain('Healthy content');
    expect(container.textContent).not.toContain('Something went wrong');
  });

  it('stays on the fallback when the route key is unchanged', () => {
    silenceConsoleError();
    const { container, root } = renderInRouter(
      createElement(ErrorBoundary, { resetKey: '/room/ABC/lobby' }, createElement(ThrowingChild)),
    );
    expect(container.textContent).toContain('Something went wrong');
    act(() => {
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(ErrorBoundary, { resetKey: '/room/ABC/lobby' }, createElement(ThrowingChild)),
        ),
      );
    });
    expect(container.textContent).toContain('Something went wrong');
  });
});

describe('ErrorBoundary state transitions', () => {
  it('getDerivedStateFromError returns the error state', () => {
    const err = new Error('boom');
    expect(ErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err });
  });

  it('clears the error state when the route key changes', () => {
    const err = new Error('boom');
    expect(
      ErrorBoundary.getDerivedStateFromProps(
        { resetKey: '/room/ABC/routes', children: null },
        { error: err, resetKey: '/room/ABC/lobby' },
      ),
    ).toEqual({ error: null, resetKey: '/room/ABC/routes' });
  });

  it('keeps the error state when the route key is unchanged', () => {
    const err = new Error('boom');
    expect(
      ErrorBoundary.getDerivedStateFromProps(
        { resetKey: '/room/ABC/lobby', children: null },
        { error: err, resetKey: '/room/ABC/lobby' },
      ),
    ).toBeNull();
  });

  it('starts with no error and the initial route key', () => {
    const boundary = new ErrorBoundary({ resetKey: '/create', children: null });
    expect(boundary.state).toEqual({ error: null, resetKey: '/create' });
  });

  it('logs the caught error to console.error (nothing leaves the device)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boundary = new ErrorBoundary({ resetKey: '/', children: null });
    const err = new Error('boom');
    const info = { componentStack: 'stack' };
    boundary.componentDidCatch(err, info);
    expect(spy).toHaveBeenCalledWith('Ayni: a page failed to render.', err, info);
  });
});

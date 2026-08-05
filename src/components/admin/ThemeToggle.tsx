'use client';

import * as React from 'react';

import { Moon, Sun } from 'lucide-react';

/**
 * Light/dark switch for the console.
 *
 * Deliberately dependency-free. `next-themes` solves the same four problems in
 * ~2 kB, but this app has one root layout, one storage key and no tri-state UI —
 * and its `disableTransitionOnChange` does the opposite of what is wanted here,
 * where transitions should be *on* for the swap and off the rest of the time.
 *
 * No `mounted` state and no skeleton: the icon swap is pure CSS
 * (`dark:hidden` / `hidden dark:block`), so server and client render byte-
 * identical markup. That means no hydration mismatch and no flash of the wrong
 * icon, which is what a `useState(false)` + `useEffect` pattern would cost.
 * The label stays mode-agnostic for the same reason.
 *
 * The pre-paint script in src/app/layout.tsx is what actually sets the initial
 * class; this component only handles changes after hydration.
 */

/** Absent = follow the OS. Only an explicit choice is ever written. */
const STORAGE_KEY = 'evokz-theme';

/** Must outlast the 220ms in the `.theme-transition` rule in globals.css. */
const TRANSITION_MS = 260;

export function ThemeToggle() {
  // Keep following the OS for as long as the user has not chosen explicitly.
  React.useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');

    const onChange = (event: MediaQueryListEvent) => {
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(STORAGE_KEY);
      } catch {
        // Private mode / storage disabled — treat as "no explicit choice".
      }
      if (stored === 'dark' || stored === 'light') return;

      const root = document.documentElement;
      root.classList.toggle('dark', event.matches);
      root.style.colorScheme = event.matches ? 'dark' : 'light';
    };

    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const timer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const toggle = React.useCallback(() => {
    const root = document.documentElement;
    const nextIsDark = !root.classList.contains('dark');

    root.classList.add('theme-transition');
    // Force a reflow so the browser registers the pre-transition colours;
    // without it the class swap can be batched into the same style
    // recalculation and the transition never plays.
    void root.offsetHeight;

    root.classList.toggle('dark', nextIsDark);
    root.style.colorScheme = nextIsDark ? 'dark' : 'light';

    try {
      localStorage.setItem(STORAGE_KEY, nextIsDark ? 'dark' : 'light');
    } catch {
      // Non-fatal: the theme still applies for this session.
    }

    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      root.classList.remove('theme-transition');
      timer.current = null;
    }, TRANSITION_MS);
  }, []);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle colour theme"
      title="Toggle colour theme"
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors duration-200 hover:border-brand-to/50 hover:text-brand-to focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Sun aria-hidden className="h-3.5 w-3.5 dark:hidden" />
      <Moon aria-hidden className="hidden h-3.5 w-3.5 dark:block" />
    </button>
  );
}

'use client';

import * as React from 'react';

import type { ActionResult } from '@/app/admin/dashboard/actions';

/**
 * Runs a server action while tracking pending/error state.
 *
 * Server actions in this app never throw — they return `ActionResult` — but a
 * transport-level failure (dropped connection, deploy mid-request) still
 * rejects, so that case is normalised into the same error channel.
 */
export function useAction<Args extends unknown[], T>(
  action: (...args: Args) => Promise<ActionResult<T>>,
) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});
  const mounted = React.useRef(true);

  // The setup body must re-arm the flag, not just the cleanup clear it: React
  // StrictMode mounts, unmounts, then remounts every effect in development, so
  // an effect that only ever sets `false` leaves the ref latched off from the
  // first render onward — and every `finally` below would then skip
  // `setPending(false)`, spinning a button forever on an action that succeeded.
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = React.useCallback(
    async (...args: Args): Promise<ActionResult<T>> => {
      setPending(true);
      setError(null);
      setFieldErrors({});

      try {
        const result = await action(...args);
        if (mounted.current && !result.ok) {
          setError(result.error);
          setFieldErrors(result.fieldErrors ?? {});
        }
        return result;
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : 'The request could not be completed.';
        if (mounted.current) setError(message);
        return { ok: false, error: message };
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [action],
  );

  const reset = React.useCallback(() => {
    setError(null);
    setFieldErrors({});
  }, []);

  return { run, pending, error, fieldErrors, reset };
}

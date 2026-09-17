/**
 * A thrown value as one line of text, for logs and operator-facing messages.
 *
 * Callers catch `unknown`: an `Error` gives its message, a string is used as it
 * is, and anything else is serialised rather than printed as `[object Object]`.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

/**
 * How long a finished poster waits before it is sent.
 *
 * A fleet of clients that all message WhatsApp on the same minute, to the second,
 * every single day is the most machine-like traffic shape there is. Meta reads
 * that pattern, not the content, so the mitigation is to stop being punctual:
 * generation still runs at the client's exact `cronTime`, and the broadcast is
 * held back by a random few minutes.
 *
 * The randomness is per row, not per client — a client whose delay was the same
 * every day would simply have moved their robotic minute, and two clients sharing
 * a `cronTime` would still fire together.
 *
 * Delays are drawn to the second rather than the minute. A spread of exactly seven
 * possible send minutes across the whole fleet is a much weaker disguise than it
 * looks, and seconds cost nothing.
 */
import { intEnv } from '@/lib/env';

/** Widest sane bounds. Guards a typo'd `.env`, not a considered setting. */
const FLOOR_SECONDS = 0;
const CEILING_SECONDS = 60 * 60;

export interface SendDelay {
  /** Absolute instant the broadcast becomes due. */
  sendAfter: Date;
  /** How long the row will wait, for the log line. */
  delaySeconds: number;
}

/**
 * Resolves the configured delay window, in seconds.
 *
 * A reversed pair (min above max) is swapped rather than rejected: the sweep must
 * not stop dispatching because two numbers in `.env` are the wrong way round, and
 * the operator's intent is unambiguous either way.
 */
export function getSendDelayWindow(): { minSeconds: number; maxSeconds: number } {
  const first = clamp(intEnv('WHATSAPP_SEND_DELAY_MIN_MINUTES', 2) * 60);
  const second = clamp(intEnv('WHATSAPP_SEND_DELAY_MAX_MINUTES', 8) * 60);

  return first <= second
    ? { minSeconds: first, maxSeconds: second }
    : { minSeconds: second, maxSeconds: first };
}

/** A fresh delay for one poster, measured from `from`. */
export function nextSendDelay(from: Date = new Date()): SendDelay {
  const { minSeconds, maxSeconds } = getSendDelayWindow();
  const spread = maxSeconds - minSeconds;
  const delaySeconds = minSeconds + Math.floor(Math.random() * (spread + 1));

  return {
    sendAfter: new Date(from.getTime() + delaySeconds * 1_000),
    delaySeconds,
  };
}

/** "4m 12s", for a log line or an operator-facing hint. */
export function describeDelay(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest}s`;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function clamp(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(CEILING_SECONDS, Math.max(FLOOR_SECONDS, Math.trunc(seconds)));
}

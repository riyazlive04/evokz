/**
 * Which fal.ai credential the pipeline spends, and what the console may say about it.
 *
 * **The rule this module exists to enforce: while an operator key is stored, the
 * platform `FAL_KEY` is never used.** Not when fal rejects the stored key, not when
 * the account is out of credit, not when the key cannot be decrypted. A silent
 * fallback would spend Evokz's money against an explicit standing instruction, and
 * because generation would keep succeeding nobody would find out until the invoice.
 * Every failure path here throws instead.
 *
 * The console reinforces this by having no way to unset the key — there is no
 * `clearFalApiKey` action, so `falKeyCipher` only ever moves null → set → another
 * key. Clearing it is a server-side task; see the note in
 * `src/app/admin/dashboard/actions.ts` and DEPLOY_VPS.md §10.
 *
 * Server-only: it reaches the database and, through `secret-box`, `node:crypto`.
 * Client components may import `FalKeyStatus` with `import type`, never the module.
 */
import { UsageKeySource } from '@prisma/client';

import { requireEnv } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import { decryptSecret, isSecretEncryptionConfigured, secretLast4 } from '@/lib/secret-box';
import { formatDisplayDateTime } from '@/lib/time';

/** The one row `AppSetting` ever holds. Both writers use this constant. */
export const APP_SETTING_ID = 'singleton';

/**
 * GCM additional-authenticated-data tag for the stored fal key. Changing this
 * string makes every already-stored key undecryptable — it is part of the data
 * format, not a label.
 */
export const FAL_KEY_PURPOSE = 'fal-key';

/**
 * A paste guard, not a validator.
 *
 * A fal key is two parts joined by a colon — `<key id>:<key secret>` — but fal has
 * changed the shape of both halves before, so this is deliberately permissive. It
 * catches the two mistakes that actually happen (pasting only one half, pasting
 * something that is not a key at all) without locking an operator out of a valid
 * key issued in a shape nobody here anticipated. **Test key is the real validator.**
 */
export const FAL_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}:[A-Za-z0-9_-]{16,128}$/;

/** The credential one generation will actually use. */
export interface FalCredentials {
  key: string;
  source: UsageKeySource;
  /** Carried so an error can name the key without a second database read. */
  last4: string;
}

/**
 * Everything the console may know about the stored key.
 *
 * There is deliberately no field here that could hold a key: this crosses the
 * server/client boundary into `ImageKeyPanel`, and the only safe way to guarantee a
 * secret never reaches the browser is for the shape to have nowhere to put one.
 */
export interface FalKeyStatus {
  /** An operator key is stored — so `FAL_KEY` is unread, whatever `health` says. */
  configured: boolean;
  last4: string | null;
  label: string | null;
  /** Pre-formatted in `APP_TIMEZONE`; the client has no zone of its own. */
  updatedAtLabel: string | null;
  health: 'none' | 'ok' | 'undecryptable';
  /** False when `SETTINGS_ENCRYPTION_KEY` is unset — saving is refused. */
  encryptionConfigured: boolean;
  /** Whether `FAL_KEY` is set, so the panel can warn when neither key exists. */
  platformKeyPresent: boolean;
}

/**
 * Cleans up a pasted key.
 *
 * Absorbs the three paste errors that actually occur: quotes carried over from a
 * `.env` line, the `Key ` prefix copied along with the Authorization header, and a
 * key that wrapped across two lines in a chat message.
 */
export function normalizeFalKey(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^key\s+/i, '')
    .replace(/\s+/g, '');
}

/**
 * The credential for one generation.
 *
 * **Not cached, deliberately.** One primary-key SELECT on a single-row table costs
 * a fraction of a millisecond inside an operation that spends 5–30 seconds waiting
 * on fal, so the read is unmeasurable. What a cache would buy is a bug: the cron
 * sweep runs in-process at `CRON_MAX_CONCURRENCY`, so a key saved mid-sweep lands
 * between rows — and resolving per row keeps that boundary legible, with every row
 * billed to, and *recorded* against, whatever it actually resolved. `revalidatePath`
 * does nothing for a module-scope variable and dev HMR gives a second module
 * instance, so a cache would also need invalidation that is easy to get wrong.
 */
export async function resolveFalCredentials(): Promise<FalCredentials> {
  const setting = await prisma.appSetting.findUnique({
    where: { id: APP_SETTING_ID },
    select: { falKeyCipher: true },
  });

  if (!setting?.falKeyCipher) {
    // No operator key: unchanged behaviour, including `requireEnv`'s throw, which
    // still lands inside the pipeline's try as a `[generate]` failure.
    const key = requireEnv('FAL_KEY');
    return { key, source: UsageKeySource.PLATFORM, last4: secretLast4(key) };
  }

  // A `SecretDecryptionError` propagates on purpose. See the module header: the
  // operator's instruction to bill their own account is intact and unreadable, and
  // quietly charging Evokz instead would be the one outcome nobody would notice.
  const key = decryptSecret(setting.falKeyCipher, FAL_KEY_PURPOSE);
  return { key, source: UsageKeySource.BYO, last4: secretLast4(key) };
}

/**
 * What the dashboard may display. Never returns the key.
 *
 * `health` is established by actually attempting the decrypt and discarding the
 * plaintext — a few microseconds — so a key orphaned by a rotated
 * `SETTINGS_ENCRYPTION_KEY` is caught on the next dashboard render rather than by
 * the next cron sweep.
 */
export async function loadFalKeyStatus(): Promise<FalKeyStatus> {
  const setting = await prisma.appSetting.findUnique({
    where: { id: APP_SETTING_ID },
    select: {
      falKeyCipher: true,
      falKeyLast4: true,
      falKeyLabel: true,
      falKeyUpdatedAt: true,
    },
  });

  const encryptionConfigured = isSecretEncryptionConfigured();
  const platformKeyPresent = (process.env.FAL_KEY ?? '').trim() !== '';

  if (!setting?.falKeyCipher) {
    return {
      configured: false,
      last4: null,
      label: null,
      updatedAtLabel: null,
      health: 'none',
      encryptionConfigured,
      platformKeyPresent,
    };
  }

  let health: FalKeyStatus['health'] = 'ok';
  try {
    decryptSecret(setting.falKeyCipher, FAL_KEY_PURPOSE);
  } catch {
    // One state for two causes — the envelope will not open, or the env key is
    // gone entirely. Both mean the stored key is unusable and both have the same
    // remedy, and `encryptionConfigured` already tells the panel which it is.
    health = 'undecryptable';
  }

  return {
    configured: true,
    last4: setting.falKeyLast4,
    label: setting.falKeyLabel,
    updatedAtLabel: setting.falKeyUpdatedAt
      ? formatDisplayDateTime(setting.falKeyUpdatedAt)
      : null,
    health,
    encryptionConfigured,
    platformKeyPresent,
  };
}

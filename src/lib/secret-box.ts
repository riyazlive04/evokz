/**
 * Symmetric encryption for secrets the console stores on the operator's behalf.
 *
 * **The opposite constraint to `src/lib/auth.ts`.** That module is Web-Crypto-only
 * because `middleware.ts` runs on the edge runtime, where the Node builtins are
 * absent. This one is `node:crypto` and must therefore never be reached from
 * middleware or from a `'use client'` module — its callers are server actions and
 * the pipeline, both of which are Node. `src/app/api/webhooks/razorpay/route.ts`
 * imports `node:crypto` on exactly the same terms.
 *
 * Envelope format, deliberately shaped like the password hash in `auth.ts`:
 *
 *     aes-256-gcm:v1:<ivHex>:<tagHex>:<ciphertextHex>
 *
 * Self-describing and versioned, so a future algorithm change can be recognised
 * rather than guessed at. Hex throughout and colon-delimited rather than the
 * conventional `$`, so the value survives being copied anywhere — including into a
 * `.env`, where Next and Docker Compose both expand `$NAME` and would silently eat
 * part of it.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENV_KEY = 'SETTINGS_ENCRYPTION_KEY';
const SCHEME = 'aes-256-gcm';
const VERSION = 'v1';
/** GCM's standard nonce length. Fresh per encryption, never reused. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_HEX_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * The deployment cannot encrypt at all: `SETTINGS_ENCRYPTION_KEY` is missing or
 * unusable.
 *
 * **This message must never carry the env value, a plaintext, or a ciphertext.**
 * `toFailure` in the dashboard actions logs `describeError(error)` straight to the
 * container log, so anything in here is written to disk.
 */
export class SecretEncryptionUnavailableError extends Error {
  constructor(public readonly reason: 'unset' | 'malformed') {
    super(
      reason === 'unset'
        ? `${ENV_KEY} is not set on this deployment.`
        : `${ENV_KEY} is not 64 hexadecimal characters.`,
    );
    this.name = 'SecretEncryptionUnavailableError';
  }
}

/**
 * A stored envelope could not be opened with the key this process holds.
 *
 * The message is fixed, operator-legible, and — like the class above — must never
 * carry key material: it is rendered into `ContentCalendar.errorMessage`, which the
 * dashboard displays verbatim.
 */
export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

/**
 * Reads the encryption key, or explains why it cannot.
 *
 * The hex shape is checked *before* decoding: `Buffer.from('zz', 'hex')` returns an
 * empty buffer rather than throwing, so a length check on the decoded bytes alone
 * would report garbage as "unset" and send the operator looking for a variable that
 * is right there in `.env`.
 */
function readEncryptionKey(): Buffer {
  const raw = process.env[ENV_KEY];
  if (raw === undefined || raw.trim() === '') {
    throw new SecretEncryptionUnavailableError('unset');
  }
  const trimmed = raw.trim();
  if (!KEY_HEX_PATTERN.test(trimmed)) {
    throw new SecretEncryptionUnavailableError('malformed');
  }
  return Buffer.from(trimmed, 'hex');
}

/** Whether this deployment can store a secret at all. Never throws. */
export function isSecretEncryptionConfigured(): boolean {
  try {
    readEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypts one secret.
 *
 * `purpose` becomes GCM's additional authenticated data — it is not secret, and it
 * is not stored, but it binds the ciphertext to the column it was written for. A
 * value lifted out of some future second secret column cannot be pasted into this
 * one and decrypt cleanly; a mismatch surfaces as an auth-tag failure, which is the
 * same legible path as a wrong key.
 */
export function encryptSecret(plaintext: string, purpose: string): string {
  const key = readEncryptionKey();
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(SCHEME, key, iv);
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [SCHEME, VERSION, iv.toString('hex'), tag.toString('hex'), body.toString('hex')].join(':');
}

/**
 * Opens an envelope written by `encryptSecret`.
 *
 * Every failure below the env-key check collapses into one fixed message. Node
 * throws a bare `Unsupported state or unable to authenticate data` from
 * `final()`, which tells an operator nothing, and the three causes an operator can
 * actually hit — a rotated `SETTINGS_ENCRYPTION_KEY`, a database restored onto a
 * box with a different one, a truncated column — all have the same remedy.
 */
export function decryptSecret(envelope: string, purpose: string): string {
  // A missing env key is a deployment fault, not a data fault, and must keep its
  // own error type so the console can tell the operator to go and set it.
  const key = readEncryptionKey();

  const parts = envelope.split(':');
  if (parts.length !== 5 || parts[0] !== SCHEME || parts[1] !== VERSION) {
    throw new SecretDecryptionError(
      'Stored secret is not in a format this version understands. Remove and re-enter it from the dashboard.',
    );
  }

  const [, , ivHex, tagHex, bodyHex] = parts as [string, string, string, string, string];

  try {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error('bad envelope geometry');
    }

    const decipher = createDecipheriv(SCHEME, key, iv);
    decipher.setAAD(Buffer.from(purpose, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(bodyHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretDecryptionError(
      `Stored key could not be decrypted — ${ENV_KEY} does not match the value it was ` +
        'encrypted with. Remove and re-enter the key from the dashboard.',
    );
  }
}

/**
 * The last four characters, for naming a stored secret without disclosing it.
 *
 * The tail of the *whole* key, deliberately, so it matches what fal.ai's own
 * dashboard shows and an operator can tell at a glance which of their keys is live.
 * Four characters of a 32-character secret is a conventional, considered
 * disclosure — not an oversight to be "fixed" to the key id later.
 */
export function secretLast4(value: string): string {
  return value.slice(-4);
}

/**
 * Generates the two auth secrets the deployment needs.
 *
 *   node scripts/hash-password.mjs                 # prompts, input hidden
 *   echo 'my password' | node scripts/hash-password.mjs
 *   node scripts/hash-password.mjs 'my password'   # leaves it in shell history
 *   node scripts/hash-password.mjs --settings-key  # SETTINGS_ENCRYPTION_KEY only
 *
 * Emits ADMIN_PASSWORD_HASH and a fresh SESSION_SECRET as .env lines. Uses
 * node:crypto rather than importing src/lib/auth.ts (which is TypeScript and
 * Web-Crypto-based) — the two must stay format-compatible:
 *
 *     pbkdf2-sha256:<iterations>:<saltHex>:<hashHex>
 *
 * The colon separator is load-bearing; see the note on `hashPassword` in
 * src/lib/auth.ts for why `$` cannot be used in a value destined for `.env`.
 */
import crypto from 'node:crypto';
import process from 'node:process';
import readline from 'node:readline';

// Must match PBKDF2_ITERATIONS in src/lib/auth.ts. A mismatch is not fatal —
// verifyPassword reads the cost out of the stored string — but keeping them
// equal means a locally generated hash costs what production pays.
const ITERATIONS = 210_000;
const KEY_LENGTH = 32;

function hash(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha256');
  return `pbkdf2-sha256:${ITERATIONS}:${salt.toString('hex')}:${derived.toString('hex')}`;
}

// Intercepted before readPassword(), which would otherwise read the flag as the
// password. Deliberately a standalone mode rather than part of the default output:
// the default run is the auth-secret *rotation* path, and printing a fresh
// settings key there would tempt an operator to paste it, silently orphaning the
// fal.ai key already stored in the database.
//
// `openssl rand -hex 32` produces the same thing if node is not to hand.
if (process.argv.includes('--settings-key')) {
  console.log('\n# --- paste into .env, then run: docker compose up -d app ---');
  console.log(`SETTINGS_ENCRYPTION_KEY="${crypto.randomBytes(32).toString('hex')}"`);
  console.log(
    '\n# Changing this later does NOT re-encrypt what is already stored: the saved\n' +
      '# fal.ai key becomes unreadable and every render fails saying so. Remove and\n' +
      '# re-enter it from the dashboard after any rotation.',
  );
  process.exit(0);
}

/** Reads a password from argv, a pipe, or an interactive prompt — in that order. */
async function readPassword() {
  const fromArgv = process.argv[2];
  if (fromArgv) return fromArgv;

  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // readline has no built-in masking, so the output stream is muted for the
  // duration of the answer and the prompt is written once by hand beforehand.
  process.stdout.write('Console password: ');
  const muted = rl.output;
  rl.output = { write() {} };

  const answer = await new Promise((resolve) => rl.question('', resolve));

  rl.output = muted;
  process.stdout.write('\n');
  rl.close();

  return answer;
}

const password = (await readPassword()).trim();

if (password.length < 12) {
  console.error(
    `Refusing to hash a ${password.length}-character password.\n` +
      'This is the only credential in front of an admin console that spends money\n' +
      'and messages real clients. Use at least 12 characters.',
  );
  process.exit(1);
}

console.log('\n# --- paste into .env, then restart the app container ---');
console.log(`ADMIN_PASSWORD_HASH="${hash(password)}"`);
console.log(`SESSION_SECRET="${crypto.randomBytes(32).toString('hex')}"`);
console.log(
  '\n# Rotating SESSION_SECRET signs every live session out immediately —\n' +
    '# it is the only revocation mechanism, since sessions are stateless.',
);

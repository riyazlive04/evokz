/**
 * Generates the two auth secrets the deployment needs.
 *
 *   node scripts/hash-password.mjs                 # prompts, input hidden
 *   echo 'my password' | node scripts/hash-password.mjs
 *   node scripts/hash-password.mjs 'my password'   # leaves it in shell history
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

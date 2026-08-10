/**
 * Stores the operator's fal.ai key from the server, without the console.
 *
 * The dashboard panel is the normal way in. This exists for the cases where it is
 * not available: the console password has been lost, the key must be rotated from
 * a deploy script, or — as when this was written — an operator would rather hand
 * the key to whoever runs the box than paste it themselves.
 *
 * Usage, from the project directory on the host:
 *
 *   printf '%s' 'key-id:key-secret' | docker compose exec -T app node scripts/set-fal-key.mjs
 *
 * The key is read from **stdin only**, never argv: an argument would be visible in
 * `ps` for the life of the process and would land in the shell history of whoever
 * ran it. Nothing here prints the key, and the only thing echoed back is its last
 * four characters — the same disclosure the dashboard makes.
 *
 * The envelope format is a deliberate duplicate of `src/lib/secret-box.ts`:
 *
 *     aes-256-gcm:v1:<ivHex>:<tagHex>:<ciphertextHex>     AAD "fal-key"
 *
 * Kept as literals rather than imported because that module is TypeScript behind a
 * `@/` alias and this is a plain node script — the same compromise
 * `scripts/import-vertical-templates.mjs` makes against the server action it
 * mirrors. If the format in secret-box.ts changes, this must follow, and the
 * round-trip check at the end is what catches the day it does not.
 */
import crypto from 'node:crypto';
import process from 'node:process';

import { PrismaClient } from '@prisma/client';

const APP_SETTING_ID = 'singleton';
const PURPOSE = 'fal-key';
const SCHEME = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;

// Mirrors FAL_KEY_PATTERN in src/lib/fal-credentials.ts — a paste guard, not a
// validator. Whether the key actually works is a question only fal.ai can answer.
const FAL_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}:[A-Za-z0-9_-]{16,128}$/;

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/** Mirrors normalizeFalKey: quotes, a stray "Key " prefix, wrapped whitespace. */
function normalize(raw) {
  return raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^key\s+/i, '')
    .replace(/\s+/g, '');
}

function readEncryptionKey() {
  const raw = (process.env.SETTINGS_ENCRYPTION_KEY ?? '').trim();
  if (raw === '') {
    fail(
      'SETTINGS_ENCRYPTION_KEY is not set in this process. Run this through\n' +
        '  `docker compose exec -T app ...` so it inherits the app service env.',
    );
  }
  // Checked before decoding: Buffer.from('zz','hex') yields an empty buffer
  // rather than throwing, so a length test alone would misreport garbage.
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    fail('SETTINGS_ENCRYPTION_KEY is not 64 hexadecimal characters.');
  }
  return Buffer.from(raw, 'hex');
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(SCHEME, key, iv);
  cipher.setAAD(Buffer.from(PURPOSE, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    SCHEME,
    VERSION,
    iv.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    body.toString('hex'),
  ].join(':');
}

function decrypt(envelope, key) {
  const [scheme, version, ivHex, tagHex, bodyHex] = envelope.split(':');
  if (scheme !== SCHEME || version !== VERSION) throw new Error('unrecognised envelope');
  const decipher = crypto.createDecipheriv(SCHEME, key, Buffer.from(ivHex, 'hex'));
  decipher.setAAD(Buffer.from(PURPOSE, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(bodyHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

async function readStdin() {
  if (process.stdin.isTTY) {
    fail("Pipe the key in on stdin — it is not read from an argument.\n" +
      "  printf '%s' 'key-id:key-secret' | docker compose exec -T app node scripts/set-fal-key.mjs");
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads back what is stored and spends one small render proving fal accepts it.
 *
 * The same question the dashboard's "Test key" answers, asked from the server —
 * and the stronger version of it, because this exercises the *stored* envelope
 * rather than a key someone still has in their clipboard. A round trip through
 * the database is the only thing that proves the whole chain.
 *
 * Costs one 512x512 flux/schnell render on the operator's own account.
 */
async function verifyStoredKey() {
  const prismaClient = new PrismaClient();
  try {
    const row = await prismaClient.appSetting.findUnique({
      where: { id: APP_SETTING_ID },
      select: { falKeyCipher: true, falKeyLast4: true, falKeyLabel: true },
    });
    if (!row?.falKeyCipher) fail('No fal.ai key is stored.');

    const plain = decrypt(row.falKeyCipher, readEncryptionKey());
    console.log(`\n  stored key ••••${row.falKeyLast4}${row.falKeyLabel ? ` (${row.falKeyLabel})` : ''}`);
    console.log('  decrypts: yes');

    // Identifies *which* key is stored without disclosing it. Compare against
    // `printf '%s' '<key>' | sha256sum` run wherever the key came from: equal
    // fingerprints prove the stored credential is that exact key, and four
    // shared last-4 characters do not.
    const fingerprint = crypto.createHash('sha256').update(plain, 'utf8').digest('hex').slice(0, 16);
    console.log(`  fingerprint (sha256, first 16): ${fingerprint}`);

    const startedAt = Date.now();
    const response = await fetch('https://fal.run/fal-ai/flux/schnell', {
      method: 'POST',
      headers: {
        Authorization: `Key ${plain}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        prompt: 'a plain neutral grey background',
        image_size: { width: 512, height: 512 },
        num_images: 1,
        sync_mode: true,
        enable_safety_checker: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (!response.ok) {
      // The body can echo request detail; print only the status.
      fail(`fal.ai rejected the stored key — HTTP ${response.status} after ${elapsed}s.`);
    }

    const payload = await response.json();
    if (!payload?.images?.[0]?.url) fail(`fal.ai returned no image after ${elapsed}s.`);

    console.log(`  fal.ai accepted it: image returned in ${elapsed}s`);
    console.log('  every render is now billed to this account.\n');
  } finally {
    await prismaClient.$disconnect();
  }
}

if (process.argv.includes('--verify')) {
  await verifyStoredKey();
  process.exit(0);
}

const label = process.argv[2] ?? null;
const key = normalize(await readStdin());

if (key === '') fail('Nothing arrived on stdin.');
if (!FAL_KEY_PATTERN.test(key)) {
  // Deliberately does not echo what was read.
  fail(
    'That does not look like a fal.ai key. It is two parts joined by a colon —\n' +
      '  "<key id>:<key secret>" — copied whole from fal.ai -> Settings -> API Keys.',
  );
}

const encryptionKey = readEncryptionKey();
const cipher = encrypt(key, encryptionKey);

// Proves the stored envelope opens again before it is written, so a format drift
// between this script and secret-box.ts cannot silently store an unreadable key.
if (decrypt(cipher, encryptionKey) !== key) {
  fail('Round-trip check failed — refusing to store a key that will not decrypt.');
}

const prisma = new PrismaClient();
const last4 = key.slice(-4);
const now = new Date();

try {
  const existing = await prisma.appSetting.findUnique({
    where: { id: APP_SETTING_ID },
    select: { falKeyLast4: true },
  });

  await prisma.appSetting.upsert({
    where: { id: APP_SETTING_ID },
    create: {
      id: APP_SETTING_ID,
      falKeyCipher: cipher,
      falKeyLast4: last4,
      falKeyLabel: label,
      falKeyUpdatedAt: now,
    },
    update: {
      falKeyCipher: cipher,
      falKeyLast4: last4,
      falKeyLabel: label,
      falKeyUpdatedAt: now,
    },
  });

  console.log(
    `\n  ${existing?.falKeyLast4 ? `replaced ••••${existing.falKeyLast4} with` : 'stored'} ` +
      `fal.ai key ••••${last4}${label ? ` (${label})` : ''}.`,
  );
  console.log('  Encrypted at rest. Takes effect on the next render — no restart.');
  console.log('  The platform FAL_KEY is now unused.\n');
} finally {
  await prisma.$disconnect();
}

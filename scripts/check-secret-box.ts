/**
 * Fixture suite for `src/lib/secret-box.ts`.
 *
 * There is no test framework in this repository, so this follows the
 * `check-logo-key.ts` pattern: a standalone script with a non-zero exit code.
 *
 * Run: npm run check:secret-box
 *
 * Worth keeping green. This module is the only thing standing between an
 * operator's fal.ai key and a plaintext column, and its two most important
 * behaviours are failures — a wrong key and a tampered ciphertext must both refuse
 * to return anything, rather than returning something plausible.
 */
import {
  decryptSecret,
  encryptSecret,
  isSecretEncryptionConfigured,
  secretLast4,
  SecretDecryptionError,
  SecretEncryptionUnavailableError,
} from '@/lib/secret-box';

const ENV_KEY = 'SETTINGS_ENCRYPTION_KEY';
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const PURPOSE = 'fal-key';
const SECRET = 'e4f1c8a2-51bd-4d0e-9c7a-2b3f8d6e1a90:9f8e7d6c5b4a39281706f5e4d3c2b1a0';

let failures = 0;

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
}

/** Runs `body` with the env key set to `value`, restoring it afterwards. */
function withKey(value: string | undefined, body: () => void): void {
  const previous = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  }
}

/** Captures whatever `body` throws, or null. */
function thrown(body: () => unknown): unknown {
  try {
    body();
    return null;
  } catch (error) {
    return error;
  }
}

// -- 1. Round trip ----------------------------------------------------------
console.log('\n1. round trip');
withKey(KEY_A, () => {
  const envelope = encryptSecret(SECRET, PURPOSE);
  check('envelope is self-describing', envelope.startsWith('aes-256-gcm:v1:'), envelope.slice(0, 15));
  check('envelope is not the plaintext', !envelope.includes(SECRET));
  check('decrypts to the original', decryptSecret(envelope, PURPOSE) === SECRET);
});

// -- 2. Fresh IV per encryption --------------------------------------------
console.log('\n2. nonce is fresh per encryption');
withKey(KEY_A, () => {
  const a = encryptSecret(SECRET, PURPOSE);
  const b = encryptSecret(SECRET, PURPOSE);
  check('same plaintext yields different ciphertext', a !== b);
  check('both still decrypt', decryptSecret(a, PURPOSE) === decryptSecret(b, PURPOSE));
});

// -- 3. Wrong key -----------------------------------------------------------
console.log('\n3. wrong encryption key');
{
  let envelope = '';
  withKey(KEY_A, () => {
    envelope = encryptSecret(SECRET, PURPOSE);
  });
  withKey(KEY_B, () => {
    const error = thrown(() => decryptSecret(envelope, PURPOSE));
    check('raises SecretDecryptionError', error instanceof SecretDecryptionError);
    check(
      'message names the env var and the remedy',
      error instanceof Error &&
        error.message.includes(ENV_KEY) &&
        /re-enter/i.test(error.message),
    );
    check(
      'message leaks neither key material nor ciphertext',
      error instanceof Error &&
        !error.message.includes(SECRET) &&
        !error.message.includes(KEY_A) &&
        !error.message.includes(KEY_B),
    );
  });
}

// -- 4. Tampered ciphertext -------------------------------------------------
console.log('\n4. tampered ciphertext');
withKey(KEY_A, () => {
  const parts = encryptSecret(SECRET, PURPOSE).split(':');
  // Flip one hex digit of the body. GCM's tag must catch it.
  const body = parts[4]!;
  parts[4] = (body[0] === '0' ? '1' : '0') + body.slice(1);
  const error = thrown(() => decryptSecret(parts.join(':'), PURPOSE));
  check('raises SecretDecryptionError', error instanceof SecretDecryptionError);
});

// -- 5. AAD mismatch --------------------------------------------------------
console.log('\n5. purpose (AAD) mismatch');
withKey(KEY_A, () => {
  const envelope = encryptSecret(SECRET, PURPOSE);
  const error = thrown(() => decryptSecret(envelope, 'some-other-secret'));
  check('a ciphertext cannot be reused under another purpose', error instanceof SecretDecryptionError);
});

// -- 6. Malformed envelope --------------------------------------------------
console.log('\n6. malformed envelope');
withKey(KEY_A, () => {
  for (const bad of ['', 'not-an-envelope', 'aes-256-gcm:v2:a:b:c', 'aes-256-gcm:v1:a:b']) {
    check(
      `rejects ${JSON.stringify(bad.slice(0, 24))}`,
      thrown(() => decryptSecret(bad, PURPOSE)) instanceof SecretDecryptionError,
    );
  }
});

// -- 7. Env key states ------------------------------------------------------
console.log('\n7. environment key states');
withKey(undefined, () => {
  const error = thrown(() => encryptSecret(SECRET, PURPOSE));
  check(
    'unset raises SecretEncryptionUnavailableError("unset")',
    error instanceof SecretEncryptionUnavailableError && error.reason === 'unset',
  );
  check('isSecretEncryptionConfigured() is false', !isSecretEncryptionConfigured());
});

withKey('   ', () => {
  const error = thrown(() => encryptSecret(SECRET, PURPOSE));
  check(
    'whitespace-only reads as unset, not malformed',
    error instanceof SecretEncryptionUnavailableError && error.reason === 'unset',
  );
});

for (const bad of ['zz'.repeat(32), 'abc', `${KEY_A}ff`]) {
  withKey(bad, () => {
    const error = thrown(() => encryptSecret(SECRET, PURPOSE));
    check(
      `"${bad.slice(0, 8)}…" raises SecretEncryptionUnavailableError("malformed")`,
      error instanceof SecretEncryptionUnavailableError && error.reason === 'malformed',
      // The 'zz…' case is the one that matters: Buffer.from returns an empty
      // buffer rather than throwing, so a length check alone would call it unset.
      error instanceof SecretEncryptionUnavailableError ? error.reason : String(error),
    );
    check('isSecretEncryptionConfigured() is false', !isSecretEncryptionConfigured());
  });
}

withKey(KEY_A.toUpperCase(), () => {
  check('uppercase hex is accepted', isSecretEncryptionConfigured());
  check(
    'and interoperates with lowercase',
    (() => {
      const envelope = encryptSecret(SECRET, PURPOSE);
      let round = '';
      withKey(KEY_A, () => {
        round = decryptSecret(envelope, PURPOSE);
      });
      return round === SECRET;
    })(),
  );
});

// -- 8. secretLast4 ---------------------------------------------------------
console.log('\n8. secretLast4');
check('takes the tail of the whole key', secretLast4(SECRET) === SECRET.slice(-4));
check('is short enough to be a hint, not a leak', secretLast4(SECRET).length === 4);

console.log(`\n${failures === 0 ? 'ALL FIXTURES PASSED' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);

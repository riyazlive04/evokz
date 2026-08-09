/**
 * Typed, lazily-validated environment access.
 *
 * Deliberately *not* validated at module load: a missing Evolution API key must
 * not stop the admin dashboard from rendering, and a missing FAL key must fail
 * inside the pipeline's try/catch so the failure lands in
 * `ContentCalendar.errorMessage` instead of crashing the process.
 */

export class MissingEnvError extends Error {
  constructor(public readonly key: string) {
    super(`Missing required environment variable: ${key}`);
    this.name = 'MissingEnvError';
  }
}

/** Reads a required variable, throwing a descriptive error when absent. */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    throw new MissingEnvError(key);
  }
  return value.trim();
}

/** Reads an optional variable, falling back to `fallback`. */
export function optionalEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

/** Reads a decimal variable, falling back when unset or unparseable. */
export function floatEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseFloat(raw.trim());
  // Negative rates would silently turn spend into income.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Reads an integer variable, falling back when unset or unparseable. */
export function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Every credential the pipeline needs at runtime, in dependency order. */
const INTEGRATION_KEYS = [
  'DATABASE_URL',
  'OPENAI_API_KEY',
  'RAZORPAY_WEBHOOK_SECRET',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'GOOGLE_DRIVE_PARENT_FOLDER_ID',
  'FAL_KEY',
  'EVOLUTION_API_URL',
  'EVOLUTION_API_KEY',
  'CRON_SECRET',
] as const;

/**
 * Names of unset integration credentials — names only, never values — so an
 * operator can tell a config gap from a code bug at a glance.
 *
 * `satisfied` lets a caller suppress a variable it knows is covered by something
 * outside the environment. The console stores an operator-supplied fal.ai key in
 * the database, and while one exists `FAL_KEY` is not merely optional but unread,
 * so listing it would be a permanent false alarm on a correctly configured box.
 * A parameter rather than a database read here, because this module is imported
 * from places that have no Prisma and must not grow one.
 */
export function findUnsetIntegrationKeys(satisfied: readonly string[] = []): string[] {
  return INTEGRATION_KEYS.filter((key) => {
    if (satisfied.includes(key)) return false;
    const value = process.env[key];
    return value === undefined || value.trim() === '';
  });
}

/** Strips surrounding quotes and unescapes `\n` in single-line PEM values. */
export function normalizePrivateKey(raw: string): string {
  return raw
    .replace(/^["']|["']$/g, '')
    .replace(/\\n/g, '\n')
    .trim();
}

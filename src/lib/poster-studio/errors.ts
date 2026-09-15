/**
 * Operator-facing failures for the AI Poster Studio.
 *
 * Every studio module throws this instead of letting a provider, Drive or Prisma
 * error travel to the browser. The `message` is written for the operator and
 * never contains a raw provider response; the underlying error is kept as
 * `cause` for the server log only.
 */

export type StudioErrorKind =
  /** Input the operator can fix: missing image, bad prompt, wrong mode. */
  | 'validation'
  /** An uploaded file that is not a readable PNG, JPEG or WebP. */
  | 'invalid-image'
  | 'image-too-large'
  /** Missing environment configuration (API key, Drive credentials). */
  | 'config'
  /** OpenAI rejected the key (401). */
  | 'auth'
  /** The key or organisation may not use this model (403). */
  | 'access'
  /** Model or endpoint not found (404). */
  | 'model'
  | 'rate-limit'
  | 'quota'
  | 'moderation'
  /** Any other request OpenAI refused (400/422). */
  | 'bad-request'
  | 'timeout'
  | 'network'
  | 'provider'
  | 'storage'
  | 'database'
  /** The client's Brand Canvas logo is missing or could not be read. */
  | 'logo'
  /**
   * "Remove background" was chosen and the keyer declined. The operator can
   * switch this poster to "Keep original"; nothing falls back silently.
   */
  | 'logo-background'
  /** The deterministic identity overlay could not be prepared or drawn (fonts, rendering). */
  | 'composition';

export class StudioError extends Error {
  constructor(
    public readonly kind: StudioErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StudioError';
  }
}

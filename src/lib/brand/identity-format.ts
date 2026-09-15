/**
 * Display formatting for Brand Canvas identity values.
 *
 * Moved out of the poster renderer unchanged so the AI Poster Studio's identity
 * overlay prints a client's phone, website and tagline exactly as the delivery
 * pipeline does. A light module on purpose: the renderer pulls in satori, resvg
 * and the Chromium template path, none of which a formatter needs.
 */

export function normalizeTagline(raw: string | null): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Strips the scheme and any trailing slash, leaving the bare host form the
 * references use (`www.loremipsum.com`, never `https://www.loremipsum.com/`).
 */
export function normalizeWebsite(raw: string | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '') || null;
}

/**
 * The contact bar's phone value.
 *
 * `displayPhone` is passed through verbatim when set — an operator who typed
 * "+91 98765 43210" chose that spacing and it must not be reformatted. Only the
 * fallback path formats, grouping Indian numbers as `+91 XXXXX XXXXX` to match the
 * reference set; anything else gets a plain `+` prefix rather than a guessed
 * grouping, since applying Indian spacing to a 9-digit European number would
 * render a number that cannot be dialled.
 */
export function formatPhone(displayPhone: string | null, whatsappNumber: string): string {
  const explicit = displayPhone?.trim();
  if (explicit) return explicit;

  const digits = whatsappNumber.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return digits ? `+${digits}` : '';
}

import { containFit } from '@/lib/poster/image-info';
import type { DayLogoPlacement, ElementBox } from '@/lib/types/template-elements';

/**
 * Where the client's logo lands inside a template's logo box — the one geometry
 * the compositor and the editor's live preview both use.
 *
 * Its own module, and not part of `clone-identity.ts`, for one reason: the
 * browser has to run exactly this arithmetic. `clone-identity.ts` imports
 * `sharp`, `satori` and `resvg`, three native server-only packages, so a client
 * component importing it would not bundle at all — and a preview that estimated
 * the placement instead would drift from the render by a few pixels, which on a
 * logo is the whole point of the controls. `clone-identity.ts` re-exports
 * everything here, so the compositor's own callers see no difference.
 *
 * Nothing here decodes an image or touches storage.
 */

export interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A normalised box in whole pixels of an image, kept inside it. */
export function toPixelBox(box: ElementBox, width: number, height: number): PixelBox {
  const left = Math.min(Math.max(Math.round(box.x * width), 0), Math.max(width - 1, 0));
  const top = Math.min(Math.max(Math.round(box.y * height), 0), Math.max(height - 1, 0));
  const right = Math.min(Math.max(Math.round((box.x + box.w) * width), left + 1), width);
  const bottom = Math.min(Math.max(Math.round((box.y + box.h) * height), top + 1), height);
  return { left, top, width: right - left, height: bottom - top };
}

/** Share of a logo box left clear on each side, so the mark does not touch its surroundings. */
export const LOGO_INSET = 0.06;

/** Smallest and largest a stored placement may scale the fitted mark by (`dayLogoPlacementSchema`). */
const MIN_PLACEMENT_SCALE = 0.5;
const MAX_PLACEMENT_SCALE = 3;

/**
 * Where the client's mark lands inside a logo box — the one geometry both sides
 * use, so the editor's live preview cannot drift from the render. Pure, and free
 * of `sharp`, so the browser can import it.
 *
 * The mark is fitted inside the box less `LOGO_INSET` on each side, so it never
 * touches its surroundings; then scaled by the admin's `scale`, clamped so it
 * never grows past the box itself; then pushed to the chosen edges, the inset
 * kept on the side it is pushed to. With no placement this is what the
 * compositor has always done: fitted, and centred both ways.
 *
 * `logo` is the mark as it is actually drawn — the trimmed one
 * (`trimLogoPadding`), not the uploaded file: only its aspect ratio is used, and
 * a transparent margin changes that ratio.
 */
export function placeLogoInBox(box: PixelBox, logo: { width: number; height: number }, placement?: DayLogoPlacement | null): PixelBox {
  const inset = Math.round(Math.min(box.width, box.height) * LOGO_INSET);
  const bounds = { width: box.width - inset * 2, height: box.height - inset * 2 };
  if (bounds.width < 1 || bounds.height < 1 || logo.width < 1 || logo.height < 1) {
    return { left: box.left, top: box.top, width: 0, height: 0 };
  }

  const fitted = containFit({ width: logo.width, height: logo.height }, bounds);
  const requested = Math.min(Math.max(placement?.scale ?? 1, MIN_PLACEMENT_SCALE), MAX_PLACEMENT_SCALE);
  const room = Math.min(box.width / Math.max(fitted.width, 1), box.height / Math.max(fitted.height, 1));
  const scale = Math.min(requested, Math.max(room, 0));
  const width = Math.min(box.width, Math.max(1, Math.round(fitted.width * scale)));
  const height = Math.min(box.height, Math.max(1, Math.round(fitted.height * scale)));

  const anchor = placement?.anchor ?? 'center';
  const vAnchor = placement?.vAnchor ?? 'middle';
  const left = anchor === 'left' ? box.left + inset : anchor === 'right' ? box.left + box.width - inset - width : box.left + Math.round((box.width - width) / 2);
  const top = vAnchor === 'top' ? box.top + inset : vAnchor === 'bottom' ? box.top + box.height - inset - height : box.top + Math.round((box.height - height) / 2);
  return {
    left: Math.min(Math.max(left, box.left), box.left + box.width - width),
    top: Math.min(Math.max(top, box.top), box.top + box.height - height),
    width,
    height,
  };
}

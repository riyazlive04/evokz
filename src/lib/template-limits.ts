/**
 * Bounds on the reference-template library, shared by the server action that
 * enforces them and the panel that renders them.
 *
 * One module rather than a literal in each place. These used to be independent
 * constants in `actions.ts` and `VerticalTemplatePanel.tsx`, which meant raising
 * one and not the other either blocked uploads the server would have accepted or
 * queued uploads guaranteed to fail — and neither says so until a file is already
 * halfway to Drive.
 *
 * Deliberately not in a module that imports Prisma or `googleapis`: the panel is a
 * client component, and pulling either into the browser bundle to read a number
 * would be a poor trade.
 */

/**
 * Templates one vertical may hold.
 *
 * Not a database constraint — the limit is an application judgement about what
 * stays reviewable, not an invariant of the data.
 */
export const MAX_TEMPLATES_PER_CATEGORY = 100;

/** Comfortably under the 8 MB Server Action body limit in next.config.mjs. */
export const MAX_TEMPLATE_BYTES = 6 * 1024 * 1024;

/**
 * Raster only. These are reference *posters* — photographs of finished
 * creatives — and an SVG here would almost certainly be a logo filed in the
 * wrong place.
 */
export const TEMPLATE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Guards the design-token system.
 *
 * Every colour in the console must come from a semantic token so it re-themes
 * automatically: `primary` for sand fills, `brand-to` for accent ink,
 * `success` / `warning` / `danger` (+ their `-ink` variants) for status, and
 * the standard shadcn surface tokens for everything else.
 *
 * Two deliberate exceptions:
 *   - `navy-*` / `sand-*` literal ramps, for surfaces that must stay fixed
 *     regardless of theme (overlays on generated creatives, chips sitting on a
 *     client's own brand colour).
 *   - src/lib/poster/**, which is a server-side image renderer working in raw
 *     hex through satori/resvg. It reads no CSS variables at all.
 *
 * Run: npm run lint:colors
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname — the latter leaves spaces percent-encoded,
// which breaks on any checkout under a path like "OneDrive - Sirah Digital".
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const SKIP = join('src', 'lib', 'poster');

const BANNED =
  /\b(?:hover:|focus:|focus-visible:|active:|group-hover:|dark:)?(?:text|bg|border|ring|divide|fill|stroke|from|to|via)-(?:red|amber|emerald|green|yellow|orange|rose|slate|gray|grey|zinc|neutral|stone|sky|blue|indigo|cyan)-\d{2,3}\b/g;

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const findings = [];

for (const file of walk(SRC)) {
  if (!/\.(tsx?|css)$/.test(file)) continue;
  const rel = relative(ROOT, file);
  if (rel.startsWith(SKIP) || rel.startsWith(SKIP.split(sep).join('/'))) continue;

  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      // Skip comment-only lines so prose mentioning a colour name is allowed.
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

      for (const match of line.match(BANNED) ?? []) {
        findings.push(`${rel}:${index + 1}  ${match}`);
      }
    });
}

if (findings.length > 0) {
  console.error(
    `Found ${findings.length} non-token colour literal(s).\n` +
      'Use a semantic token (primary, brand-to, success/warning/danger and their\n' +
      '-ink variants) so the colour re-themes, or navy-*/sand-* if the surface is\n' +
      'deliberately theme-invariant.\n',
  );
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}

console.log('lint:colors clean — every colour routes through a design token.');

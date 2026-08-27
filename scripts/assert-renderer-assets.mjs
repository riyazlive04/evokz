/**
 * Fails the Docker build if the poster renderer's runtime assets are missing.
 *
 * Run in the runner stage, which is the only place the mistake can be made: the
 * builder has the whole repository, so a template or a typeface is always
 * present there. The runner carries no `src` at all, and its two COPY lines are
 * exactly the sort of thing that gets dropped in a rebase and noticed a week
 * later, on one client's poster, in production.
 *
 * A separate file rather than an inline `node -e` because the message matters
 * more than the check: whoever hits this is reading a build log, and each of
 * the three causes has a different fix.
 */
import { readdirSync } from 'node:fs';

import { chromium } from 'playwright';

const problems = [];

const dir = read('src/lib/poster/templates');
const templates = dir.filter((f) => f.endsWith('.html'));
for (const shared of ['_kit.svg', '_base.css']) {
  if (!dir.includes(shared)) {
    problems.push(
      `${shared} is missing. Every template depends on it, so its absence fails ` +
        'the whole fleet rather than one poster.',
    );
  }
}
if (templates.length === 0) {
  problems.push(
    'No poster templates in the image. The runner stage must COPY ' +
      'src/lib/poster/templates — it is not part of .next.',
  );
}

const fonts = read('src/lib/poster/fonts').filter((f) => f.endsWith('.woff2'));
if (fonts.length < 2) {
  problems.push(
    'Poster typefaces are missing. The runner stage must COPY ' +
      'src/lib/poster/fonts; without them every poster renders in a fallback ' +
      'face, which looks like a poster and is not one.',
  );
}

/*
 * The browser is checked by *using* it, not by looking for a file.
 *
 * `existsSync(chromium.executablePath())` was the first version and it proves
 * the wrong thing twice over: it reports the full browser's path even when only
 * the headless shell is installed, and a present binary says nothing about the
 * forty shared libraries it dynamically links. A launch that renders one pixel
 * covers both, and costs about two seconds of build time.
 */
let rendered = 0;
try {
  const browser = await chromium.launch({ args: ['--no-sandbox'], chromiumSandbox: false });
  const page = await browser.newPage();
  await page.setContent('<div style="width:8px;height:8px;background:#017b84"></div>');
  rendered = (await page.screenshot({ type: 'png' })).length;
  await browser.close();
} catch (error) {
  problems.push(
    `Chromium could not be launched: ${error.message}. Either the ` +
      '`playwright install --with-deps chromium-headless-shell` step did not take, or ' +
      'PLAYWRIGHT_BROWSERS_PATH differs between the install and this check.',
  );
}
if (rendered === 0 && problems.length === 0) {
  problems.push('Chromium launched but produced an empty screenshot.');
}

if (problems.length > 0) {
  console.error(`\n${problems.map((p) => `  · ${p}`).join('\n')}\n`);
  process.exit(1);
}

console.log(
  `poster renderer ok — ${templates.length} template(s), ${fonts.length} typeface(s), ` +
    `chromium rendered a ${rendered}-byte probe`,
);

function read(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

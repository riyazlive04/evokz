import { chromium, type Browser } from 'playwright';

import { intEnv } from '@/lib/env';

/**
 * The headless Chromium the poster renderer screenshots.
 *
 * **One browser per process, many pages.** A launch costs roughly 300 ms and
 * 100 MB, and the dispatch sweep renders several posters a minute; paying that
 * per poster on a 2-CPU box would dominate the render. Pages are cheap and each
 * render gets its own context, so nothing leaks between two clients' posters.
 *
 * **Determinism is a requirement, not a nicety.** A retry after a WhatsApp
 * failure is compared against the original, so the same input has to produce the
 * same bytes. Chromium is deterministic given the same version and the same
 * rasterisation settings, which is why the flags below are not optional and why
 * `playwright` is pinned to an exact version in package.json rather than a
 * caret range — a minor bump changes the Chromium build and therefore the
 * pixels. `check:templates` renders each template twice and compares hashes, so
 * a drift is caught by a check rather than by an operator squinting at two
 * posters.
 */

const LAUNCH_ARGS = [
  /*
   * Subpixel antialiasing samples the *background* the glyph lands on, so the
   * same headline over a photograph rasterises differently depending on the
   * pixels behind it — and differently again between a machine with LCD
   * subpixel order RGB and one with BGR. Greyscale antialiasing removes both.
   */
  '--disable-lcd-text',
  /*
   * Hinting snaps stems to the pixel grid using platform-specific tables. Left
   * on, the Windows dev machine and the Debian container set the same headline
   * at visibly different widths, which makes a local preview stop predicting
   * what the client receives.
   */
  '--font-render-hinting=none',
  /*
   * Without this Chromium adopts the host's display profile, so the same teal
   * comes out at different RGB values on the dev machine and the VPS. sRGB is
   * what the reference JPEGs are in and what WhatsApp will show.
   */
  '--force-color-profile=srgb',
  /*
   * GPU rasterisation is a different code path from the CPU one and is not
   * bit-stable across drivers. There is no GPU on the VPS anyway.
   */
  '--disable-gpu',
  '--disable-software-rasterizer',
  /*
   * Docker gives a container 64 MB of /dev/shm by default and Chromium will
   * happily exceed it rendering a 900×1600 page with photographs on it, dying
   * with a bare "Target closed" that says nothing about shared memory.
   */
  '--disable-dev-shm-usage',
  /*
   * The container runs as `node`, an unprivileged user with no CAP_SYS_ADMIN, so
   * Chromium's setuid sandbox cannot initialise and the launch fails outright.
   *
   * Safe *here* specifically because of what this page is: markup this
   * repository wrote, with no network access, and client copy that reaches the
   * DOM through `textContent` rather than a parser (see fill.ts). Nothing a
   * client or an operator types can become script. If a template ever needs to
   * load something remote, this decision has to be revisited.
   */
  '--no-sandbox',
  '--hide-scrollbars',
  '--mute-audio',
];

let browser: Promise<Browser> | null = null;

export function posterBrowser(): Promise<Browser> {
  if (!browser) {
    browser = chromium
      .launch({ args: LAUNCH_ARGS, chromiumSandbox: false })
      .catch((error: unknown) => {
        // Not remembered as a failure: the commonest cause is a missing browser
        // binary in a fresh checkout, and the fix — `npx playwright install
        // chromium` — must not require restarting the dev server to take.
        browser = null;
        throw new Error(
          `Chromium could not be launched for the poster renderer: ${describe(error)}. ` +
            'If this is a fresh checkout, run `npx playwright install chromium`; if it ' +
            'is the container, the image did not install the browser.',
        );
      });
  }
  return browser;
}

/**
 * Shuts the browser down.
 *
 * Only the check scripts need this — a long-lived Next process keeps the browser
 * for its lifetime, which is the point. Without it a script that renders a
 * poster hangs at the end holding a live child process.
 */
export async function closePosterBrowser(): Promise<void> {
  if (!browser) return;
  const running = browser;
  browser = null;
  await (await running).close().catch(() => undefined);
}

/** Ceiling on one poster's render, after which the page is torn down. */
export function renderTimeoutMs(): number {
  return intEnv('POSTER_RENDER_TIMEOUT_MS', 30_000);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

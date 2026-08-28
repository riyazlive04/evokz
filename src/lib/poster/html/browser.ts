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
/* The resolved browser, so health can be answered without awaiting. */
let liveBrowser: Browser | null = null;

function launchBrowser(): Promise<Browser> {
  return chromium
    .launch({ args: LAUNCH_ARGS, chromiumSandbox: false })
    .catch((error: unknown) => {
      throw new Error(
        `Chromium could not be launched for the poster renderer: ${describe(error)}. ` +
          'If this is a fresh checkout, run `npx playwright install chromium`; if it ' +
          'is the container, the image did not install the browser.',
      );
    });
}

/**
 * The shared browser, relaunched if the one being held has died.
 *
 * **The liveness check is the whole point of this function.** Caching the launch
 * promise and handing it back forever is correct right up until Chromium exits —
 * an OOM, a crashed renderer process, a killed child — after which the slot
 * still holds a resolved promise for a dead `Browser`. Every later render then
 * calls `newContext()` on it and fails with "Target page, context or browser has
 * been closed", *for the lifetime of the Node process*.
 *
 * That failure had no floor. It was not one poster: it was every poster for
 * every client, silently, until somebody restarted the container — and nothing
 * would have told them to, because the health check watches the login page and a
 * dead browser leaves the web server perfectly healthy. A launch failure was
 * already handled; dying after a successful launch was not, and it is the case
 * that actually happens in production.
 *
 * Two attempts, not a loop: the first can find a corpse and clear it, the second
 * gets a browser that was launched a microsecond ago. If *that* one is already
 * disconnected the fault is not a dead browser, and retrying would spin.
 *
 * `browser === current` before every write, so a caller that finds a corpse
 * cannot stamp on the fresh launch another caller has already started.
 */
export async function posterBrowser(): Promise<Browser> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = browser ?? (browser = launchBrowser());

    let instance: Browser;
    try {
      instance = await current;
    } catch (error: unknown) {
      // Not remembered as a failure: the commonest cause is a missing browser
      // binary in a fresh checkout, and the fix — `npx playwright install
      // chromium` — must not require restarting the dev server to take.
      if (browser === current) browser = null;
      throw error;
    }

    if (instance.isConnected()) {
      liveBrowser = instance;
      return instance;
    }
    if (browser === current) browser = null;
    if (liveBrowser === instance) liveBrowser = null;
  }

  throw new Error(
    'The poster renderer launched Chromium and it was already disconnected. ' +
      'The browser is dying at startup rather than being lost later — check the ' +
      "container's memory and /dev/shm before looking at the renderer.",
  );
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
  liveBrowser = null;
  await (await running).close().catch(() => undefined);
}

/*
 * A running record of whether the renderer is actually working.
 *
 * The container's health check watches the login page, so a renderer that
 * cannot draw anything still reports healthy and nobody is told. This is the
 * cheapest honest signal: not a synthetic probe on a timer, which costs a
 * Chromium and can be aimed at the box by anyone who finds the URL, but the
 * outcome of the renders the platform was doing anyway.
 *
 * Consecutive rather than a rate, because that is the shape of the failure
 * worth restarting for. One poster failing is a bad photograph or impossible
 * copy; four in a row is the renderer.
 */
const UNHEALTHY_AFTER = 4;

let consecutiveFailures = 0;
let lastRenderAt: number | null = null;

/** Called by `renderHtmlPoster` for every attempt, successful or not. */
export function recordRenderOutcome(succeeded: boolean): void {
  lastRenderAt = Date.now();
  consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
}

export interface RendererHealth {
  ok: boolean;
  consecutiveFailures: number;
  /** ISO timestamp of the last attempt, or null if none has been made yet. */
  lastRenderAt: string | null;
  /** Whether a browser is currently held and still connected. */
  browser: 'idle' | 'live' | 'dead';
}

/**
 * The renderer's state, for the health endpoint.
 *
 * Deliberately carries no error text. This is served unauthenticated so the
 * container's health check can reach it, and a failure message can hold a Drive
 * URL, a client's name or a path. Counts and timestamps say everything an
 * operator needs — the reason is in the logs, behind the session.
 *
 * A process that has not rendered yet is healthy, not unknown: a box that came
 * up thirty seconds ago has nothing to prove.
 */
export function rendererHealth(): RendererHealth {
  return {
    ok: consecutiveFailures < UNHEALTHY_AFTER,
    consecutiveFailures,
    lastRenderAt: lastRenderAt === null ? null : new Date(lastRenderAt).toISOString(),
    browser: browserState(),
  };
}

function browserState(): 'idle' | 'live' | 'dead' {
  if (!browser) return 'idle';
  // The promise is not awaited: this must not block a health check, and a
  // browser still launching is not yet a browser that has died.
  return liveBrowser?.isConnected() === true ? 'live' : 'dead';
}

/** Ceiling on one poster's render, after which the page is torn down. */
export function renderTimeoutMs(): number {
  return intEnv('POSTER_RENDER_TIMEOUT_MS', 30_000);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

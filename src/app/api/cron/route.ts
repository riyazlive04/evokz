import { NextResponse, type NextRequest } from 'next/server';

import { describeError } from '@/lib/ai-pipeline';
import { executeIntervalDispatch } from '@/lib/cron-worker';
import { optionalEnv } from '@/lib/env';

/**
 * Recurrent dispatch trigger — safe to call every 5 minutes.
 * See `vercel.json` for the schedule; any external scheduler works provided it
 * sends `Authorization: Bearer $CRON_SECRET`.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function isAuthorized(request: NextRequest): boolean {
  const secret = optionalEnv('CRON_SECRET', '');

  // Fail closed: an unset secret would otherwise expose the dispatcher.
  if (!secret) return false;

  const header = request.headers.get('authorization');
  if (constantTimeEquals(header ?? '', `Bearer ${secret}`)) return true;

  /*
   * Some schedulers cannot set headers, so a query token is accepted as a
   * fallback — but it is the weaker path and should be retired. A reverse proxy
   * logs the full request URI, so every use of it writes CRON_SECRET in
   * cleartext into an access log that then rotates and is backed up. Neither
   * shipped scheduler needs it: scripts/dispatch-cron.sh and vercel.json both
   * send the header. The warning exists so a deployment still relying on it is
   * visible rather than silent.
   */
  const token = request.nextUrl.searchParams.get('token');
  if (token !== null && constantTimeEquals(token, secret)) {
    console.warn(
      '[ace:cron] authorised via ?token= — the secret is now in this request URI and any proxy access log. ' +
        'Switch the scheduler to the Authorization header.',
    );
    return true;
  }

  return false;
}

/**
 * Length-independent comparison, so a wrong guess takes the same time whatever
 * prefix it got right. `===` on strings short-circuits at the first differing
 * byte; every other credential check in this codebase is already constant-time
 * and this was the last one that was not.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await executeIntervalDispatch();

    return NextResponse.json({
      ok: true,
      ranAt: summary.ranAt,
      timeZone: summary.timeZone,
      minuteWindow: summary.minuteWindow,
      matchedClients: summary.matchedClients,
      queuedItems: summary.queuedItems,
      delivered: summary.delivered,
      failed: summary.failed,
      skipped: summary.skipped,
      // Campaign delivery is its own queue; its counts would otherwise be
      // invisible in a scheduler log that only reports the legacy totals.
      campaignSent: summary.campaignSent,
      campaignFailed: summary.campaignFailed,
      campaignSkipped: summary.campaignSkipped,
      campaignGenerated: summary.campaignGenerated,
      campaignGenerationFailed: summary.campaignGenerationFailed,
      // Per-item detail stays terse: this response goes into scheduler logs.
      items: summary.items.map((item) => ({
        calendarId: item.calendarId,
        companyName: item.companyName,
        dayNumber: item.dayNumber,
        status: item.outcome.status,
        ...(item.outcome.ok ? {} : { stage: item.outcome.stage, error: item.outcome.error }),
      })),
    });
  } catch (error) {
    // A sweep-level failure (DB unreachable, bad timezone config) must return
    // 500 so the scheduler surfaces it, without leaking internals.
    console.error('[ace:cron] sweep aborted:', describeError(error));
    return NextResponse.json(
      { ok: false, error: 'Dispatch sweep failed' },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

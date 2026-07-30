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
  if (header === `Bearer ${secret}`) return true;

  // Some schedulers cannot set headers; a query token is accepted as fallback.
  return request.nextUrl.searchParams.get('token') === secret;
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

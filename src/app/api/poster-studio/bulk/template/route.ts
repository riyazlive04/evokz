import { NextResponse } from 'next/server';

import { buildBatchTemplate } from '@/lib/poster-studio/batch-sheet';

/**
 * The bulk Poster Studio sheet template: Day, Prompt and the optional columns,
 * three example rows, and a second sheet listing festivals and formats.
 *
 * Behind the admin session: `src/middleware.ts` gates this path like every
 * other that is not on its exclusion list.
 */
export const runtime = 'nodejs';

export async function GET() {
  const body = await buildBatchTemplate();
  return new NextResponse(body as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="poster-studio-bulk-template.xlsx"',
      'Cache-Control': 'private, no-store',
    },
  });
}

import React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FileSpreadsheet } from 'lucide-react';

import { PageHeader } from '@/components/admin/PageHeader';
import { BatchWorkspace } from '@/components/studio/bulk/BatchWorkspace';
import { getStudioImageQuality } from '@/lib/ai/openai-images';
import { estimateStudioBatchCost, studioBatchConcurrency } from '@/lib/poster-studio/batch-service';
import { loadStudioBatchView } from '@/lib/poster-studio/batch-view';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * The page's own worker makes one row per server action — one image call of up
 * to a couple of minutes, plus saving it to a campaign day.
 */
export const maxDuration = 300;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BulkBatchPage({ params }: { params: { batchId: string } }) {
  if (!UUID_PATTERN.test(params.batchId)) notFound();
  const view = await loadStudioBatchView(prisma, params.batchId);
  if (!view) notFound();
  const toMake = view.status === 'DRAFT' ? view.items.length : view.counts.QUEUED + view.counts.GENERATING;
  const estimate = await estimateStudioBatchCost(prisma, toMake);

  return (
    <div className="space-y-6">
      <PageHeader icon={FileSpreadsheet} eyebrow="Bulk posters" title={view.name}>
        <Link
          href="/admin/poster-studio/bulk"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> All batches
        </Link>
      </PageHeader>
      <BatchWorkspace
        initial={view}
        estimate={estimate}
        concurrency={studioBatchConcurrency()}
        defaultQuality={getStudioImageQuality()}
      />
    </div>
  );
}

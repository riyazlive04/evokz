import React from 'react';
import Link from 'next/link';
import { ArrowLeft, FileSpreadsheet } from 'lucide-react';

import { PageHeader } from '@/components/admin/PageHeader';
import { BulkUploadForm } from '@/components/studio/bulk/BulkUploadForm';
import { getStudioImageQuality } from '@/lib/ai/openai-images';
import { listStudioBatches } from '@/lib/poster-studio/batch-view';
import { prisma } from '@/lib/prisma';
import { formatDisplayDate } from '@/lib/time';

export const dynamic = 'force-dynamic';

const STATUS_LABEL = { DRAFT: 'Draft', RUNNING: 'Generating', PAUSED: 'Paused', DONE: 'Finished', CANCELLED: 'Cancelled' } as const;

/**
 * Bulk Poster Studio: upload a Day + Prompt sheet, get one image per row —
 * as studio images, or as posters for a campaign's days.
 */
export default async function BulkPosterStudioPage() {
  const [clients, campaigns, batches] = await Promise.all([
    prisma.client.findMany({ where: { isActive: true }, select: { id: true, companyName: true }, orderBy: { companyName: 'asc' } }),
    prisma.campaign.findMany({
      where: { status: { in: ['DRAFT', 'ACTIVE', 'PAUSED'] } },
      select: { id: true, name: true, status: true, durationDays: true, client: { select: { companyName: true } } },
      orderBy: [{ client: { companyName: 'asc' } }, { name: 'asc' }],
    }),
    listStudioBatches(prisma),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FileSpreadsheet}
        eyebrow="AI Studio"
        title="Bulk posters from Excel"
        description="Upload a sheet of Day + Prompt rows and get one poster per row, made from the prompt alone — as studio images, or straight onto a campaign's days."
      >
        <Link
          href="/admin/poster-studio"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Poster Studio
        </Link>
      </PageHeader>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6 items-start">
        <div className="xl:col-span-3">
          <BulkUploadForm
            clients={clients}
            campaigns={campaigns.map((campaign) => ({
              id: campaign.id,
              name: campaign.name,
              clientName: campaign.client.companyName,
              status: campaign.status,
              durationDays: campaign.durationDays,
            }))}
            defaultQuality={getStudioImageQuality()}
          />
        </div>

        <div className="xl:col-span-2 rounded-xl border border-border bg-card p-4 space-y-3 shadow-sm">
          <h2 className="text-xs font-semibold text-foreground">Recent batches</h2>
          {batches.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">No bulk runs yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {batches.map((batch) => (
                <li key={batch.id}>
                  <Link href={`/admin/poster-studio/bulk/${batch.id}`} className="block py-2.5 hover:bg-muted/50 rounded-md px-2 -mx-2">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-foreground truncate">{batch.name}</span>
                      <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">{STATUS_LABEL[batch.status]}</span>
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {batch.target === 'CAMPAIGN' ? `${batch.campaignName ?? 'Removed campaign'} · ` : batch.clientName ? `${batch.clientName} · ` : ''}
                      {batch.succeeded}/{batch.total} made{batch.failed ? ` · ${batch.failed} failed` : ''} · {formatDisplayDate(new Date(batch.createdAt))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ArrowLeft, FolderOpen } from 'lucide-react';

import BrandCanvasView from '@/components/brand/BrandCanvasView';
import { BrandTokenizerPanel } from '@/components/brand/BrandTokenizerPanel';
import { PosterIdentityPanel } from '@/components/brand/PosterIdentityPanel';
import { Button } from '@/components/ui/button';
import { prisma } from '@/lib/prisma';
import { parseBrandGuideline } from '@/lib/types/brand';

export const dynamic = 'force-dynamic';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ClientBrandCanvasPage({
  params,
}: {
  params: { clientId: string };
}) {
  if (!UUID_PATTERN.test(params.clientId)) notFound();

  const client = await prisma.client.findUnique({
    where: { id: params.clientId },
    select: {
      id: true,
      companyName: true,
      brandGuideline: true,
      gDriveFolderId: true,
      logoUrl: true,
      logoDriveFileId: true,
      brandTagline: true,
      websiteUrl: true,
      displayPhone: true,
      whatsappNumber: true,
      category: { select: { name: true } },
    },
  });

  if (!client) notFound();

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={`/admin/clients/${client.id}`}>
            <ArrowLeft className="h-4 w-4" />
            Back to {client.companyName}
          </Link>
        </Button>

        {client.gDriveFolderId && (
          <Button asChild variant="outline" size="sm">
            <a
              href={`https://drive.google.com/drive/folders/${client.gDriveFolderId}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              <FolderOpen className="h-4 w-4" />
              Open Drive vault
            </a>
          </Button>
        )}
      </div>

      <BrandCanvasView
        clientData={{
          id: client.id,
          companyName: client.companyName,
          brandGuideline: client.brandGuideline,
          categoryName: client.category.name,
          gDriveFolderId: client.gDriveFolderId,
        }}
      />

      <PosterIdentityPanel
        clientId={client.id}
        companyName={client.companyName}
        logoUrl={client.logoUrl}
        logoDriveFileId={client.logoDriveFileId}
        brandTagline={client.brandTagline}
        websiteUrl={client.websiteUrl}
        displayPhone={client.displayPhone}
        whatsappNumber={client.whatsappNumber}
        hasDriveFolder={Boolean(client.gDriveFolderId)}
      />

      <BrandTokenizerPanel
        clientId={client.id}
        companyName={client.companyName}
        hasTokens={parseBrandGuideline(client.brandGuideline).colors.length > 0}
      />
    </>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ArrowLeft, FolderOpen } from 'lucide-react';

import BrandCanvasView from '@/components/brand/BrandCanvasView';
import { BrandTokenizerPanel } from '@/components/brand/BrandTokenizerPanel';
import { ManualBrandPanel } from '@/components/brand/ManualBrandPanel';
import { PosterIdentityPanel } from '@/components/brand/PosterIdentityPanel';
import { WebsiteColorPanel } from '@/components/brand/WebsiteColorPanel';
import { Button } from '@/components/ui/button';
import { prisma } from '@/lib/prisma';
import { parseBrandGuideline } from '@/lib/types/brand';

export const dynamic = 'force-dynamic';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where "Back" goes.
 *
 * A `?return=` is honoured only when it is a relative `/admin/…` path. Anything
 * else — a protocol-relative `//evil.com`, an absolute URL, a path outside the
 * console — falls back to the client detail page, so the parameter cannot be
 * used to bounce an operator off-site.
 */
function resolveReturnPath(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  if (!value.startsWith('/admin/') || value.startsWith('//')) return null;
  return value;
}

export default async function ClientBrandCanvasPage({
  params,
  searchParams,
}: {
  params: { clientId: string };
  searchParams: { return?: string | string[] };
}) {
  if (!UUID_PATTERN.test(params.clientId)) notFound();

  const returnPath = resolveReturnPath(searchParams.return);

  const client = await prisma.client.findUnique({
    where: { id: params.clientId },
    select: {
      id: true,
      companyName: true,
      brandGuideline: true,
      gDriveFolderId: true,
      logoUrl: true,
      logoDriveFileId: true,
      logoOriginalUrl: true,
      logoBackgroundRemoved: true,
      logoIncludesName: true,
      brandTagline: true,
      websiteUrl: true,
      displayPhone: true,
      whatsappNumber: true,
      category: { select: { name: true } },
    },
  });

  if (!client) notFound();

  const guideline = parseBrandGuideline(client.brandGuideline);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Deliberately a link, not an auto-redirect on save: this page has four
            independent save actions (tagline/website/phone, logo upload, logo
            URL, tokenizer). Redirecting after the first one would eject the
            operator before they finished. */}
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={returnPath ?? `/admin/clients/${client.id}`}>
            <ArrowLeft className="h-4 w-4" />
            {returnPath ? 'Back to demo workspace' : `Back to ${client.companyName}`}
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
        logoOriginalUrl={client.logoOriginalUrl}
        logoBackgroundRemoved={client.logoBackgroundRemoved}
        logoIncludesName={client.logoIncludesName}
        brandTagline={client.brandTagline}
        websiteUrl={client.websiteUrl}
        displayPhone={client.displayPhone}
        whatsappNumber={client.whatsappNumber}
        hasDriveFolder={Boolean(client.gDriveFolderId)}
      />

      <WebsiteColorPanel
        clientId={client.id}
        companyName={client.companyName}
        websiteUrl={client.websiteUrl}
      />

      <BrandTokenizerPanel
        clientId={client.id}
        companyName={client.companyName}
        hasTokens={guideline.colors.length > 0}
      />

      {/* Last of the three routes on purpose: the website harvest and the
          tokenizer both derive tokens from something the client already has, and
          are preferable when there is anything to read. This is what remains when
          there is not. */}
      <ManualBrandPanel
        clientId={client.id}
        companyName={client.companyName}
        guideline={guideline}
      />
    </>
  );
}

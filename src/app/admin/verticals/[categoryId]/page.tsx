import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ArrowLeft, FolderOpen, Layers } from 'lucide-react';

import { PageHeader } from '@/components/admin/PageHeader';
import {
  VerticalTemplatePanel,
  type VerticalTemplateRow,
} from '@/components/admin/VerticalTemplatePanel';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { buildThumbnailUrl } from '@/lib/google-drive';
import { prisma } from '@/lib/prisma';

/**
 * Reference-template library for one vertical.
 *
 * Mirrors the client brand page: a UUID guard, a back link, then panels that
 * each own their own save action. There is no redirect after upload — an
 * operator adding ten posters should not be ejected by the first one.
 */

export const dynamic = 'force-dynamic';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function VerticalDetailPage({
  params,
}: {
  params: { categoryId: string };
}) {
  if (!UUID_PATTERN.test(params.categoryId)) notFound();

  const category = await prisma.category.findUnique({
    where: { id: params.categoryId },
    select: {
      id: true,
      name: true,
      _count: { select: { clients: true } },
      templates: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          label: true,
          gDriveFileId: true,
          gDriveViewUrl: true,
          width: true,
          height: true,
        },
      },
    },
  });

  if (!category) notFound();

  const templates: VerticalTemplateRow[] = category.templates.map((template) => ({
    id: template.id,
    label: template.label,
    // Derived, never persisted: the API's own thumbnailLink is fixed-size and
    // expires, and the `lh3` host is the one that answers with permissive CORS.
    thumbnailUrl: buildThumbnailUrl(template.gDriveFileId, 640),
    viewUrl: template.gDriveViewUrl,
    width: template.width,
    height: template.height,
  }));

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/admin/verticals">
            <ArrowLeft className="h-4 w-4" />
            Back to verticals
          </Link>
        </Button>

        <span className="font-mono text-[11px] text-muted-foreground">
          {category._count.clients} client{category._count.clients === 1 ? '' : 's'}
        </span>
      </div>

      <PageHeader
        icon={Layers}
        eyebrow="Configuration"
        title={category.name}
        description="Reference posters for this vertical. A library for the layout work — nothing here changes generated creatives yet."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FolderOpen className="h-3.5 w-3.5 text-brand-to" />
            Reference templates
          </CardTitle>
          <CardDescription className="text-[11px]">
            Competitor or house posters that show how {category.name} creatives should
            look. Uploads land in this vertical&apos;s own Drive folder.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VerticalTemplatePanel
            categoryId={category.id}
            categoryName={category.name}
            templates={templates}
          />
        </CardContent>
      </Card>
    </>
  );
}

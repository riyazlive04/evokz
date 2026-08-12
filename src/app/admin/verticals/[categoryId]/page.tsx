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

/**
 * Templates listed at once.
 *
 * The cap is a hundred per vertical, and every card carries a Drive-hosted image
 * and its own layout picker — a hundred of those is a great deal of DOM for a
 * surface an operator works through a screenful at a time.
 */
const TEMPLATES_PER_PAGE = 24;

function parsePage(raw: string | string[] | undefined): number {
  const value = Number.parseInt(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''), 10);
  return Number.isFinite(value) && value > 1 ? value : 1;
}

export default async function VerticalDetailPage({
  params,
  searchParams,
}: {
  params: { categoryId: string };
  searchParams: { page?: string | string[] };
}) {
  if (!UUID_PATTERN.test(params.categoryId)) notFound();

  const page = parsePage(searchParams.page);

  const category = await prisma.category.findUnique({
    where: { id: params.categoryId },
    select: {
      id: true,
      name: true,
      _count: { select: { clients: true, templates: true } },
      templates: {
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * TEMPLATES_PER_PAGE,
        take: TEMPLATES_PER_PAGE,
        select: {
          id: true,
          label: true,
          gDriveFileId: true,
          gDriveViewUrl: true,
          width: true,
          height: true,
          archetype: true,
        },
      },
    },
  });

  if (!category) notFound();

  const templates: VerticalTemplateRow[] = category.templates.map((template) => ({
    id: template.id,
    label: template.label,
    // Through the console's own route, not a Google content host. References
    // are uploaded unpublished, so `lh3` has nothing to serve for them — and
    // this way the images are readable by an operator with a session and by
    // nobody else.
    thumbnailUrl: `/api/templates/${template.id}/thumbnail?w=640`,
    viewUrl: `/api/templates/${template.id}/thumbnail?full=1`,
    width: template.width,
    height: template.height,
    archetype: template.archetype,
  }));

  const totalTemplates = category._count.templates;
  const pageCount = Math.max(1, Math.ceil(totalTemplates / TEMPLATES_PER_PAGE));
  // A page past the end — a hand-edited URL, or a template deleted from the last
  // page — would otherwise render an empty grid with no way back.
  if (page > pageCount) notFound();

  // Counted in the database, not over `templates` — that array is now one page,
  // and a per-page figure would report "3 of 24 mapped" on a library of ninety.
  const mapped = await prisma.categoryTemplate.count({
    where: { categoryId: category.id, archetype: { not: null } },
  });

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
        description={
          mapped > 0
            ? `Reference posters for this vertical. ${mapped} of ${totalTemplates} are mapped to a layout, and those layouts are what this vertical's clients receive — in proportion, so mapping five references to one layout makes it five times as likely as a layout mapped once.`
            : 'Reference posters for this vertical. Map each one to the layout it represents and generated creatives will follow them; unmapped templates are stored but never used.'
        }
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
            totalCount={totalTemplates}
          />

          {pageCount > 1 && (
            <nav
              aria-label="Template pages"
              className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4"
            >
              <Button
                asChild={page > 1}
                variant="outline"
                size="sm"
                disabled={page <= 1}
              >
                {page > 1 ? (
                  <Link href={`/admin/verticals/${category.id}?page=${page - 1}`}>
                    Previous
                  </Link>
                ) : (
                  <span>Previous</span>
                )}
              </Button>

              <span className="font-mono text-[11px] text-muted-foreground">
                Page {page} of {pageCount} · {totalTemplates} templates
              </span>

              <Button
                asChild={page < pageCount}
                variant="outline"
                size="sm"
                disabled={page >= pageCount}
              >
                {page < pageCount ? (
                  <Link href={`/admin/verticals/${category.id}?page=${page + 1}`}>Next</Link>
                ) : (
                  <span>Next</span>
                )}
              </Button>
            </nav>
          )}
        </CardContent>
      </Card>
    </>
  );
}

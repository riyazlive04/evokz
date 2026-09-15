import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';

/**
 * Which `ContentCalendar` rows the legacy calendar tooling may touch.
 *
 * The table holds two kinds of row. A row with `campaignId` null belongs to the
 * original one-calendar-per-client pipeline: the dashboard's bulk actions, the
 * sheet importer, the AI seeder, manual uploads and the dispatch sweep. A row
 * with `campaignId` set is a campaign day (src/lib/campaign), whose content,
 * template and posters are versioned and changed only by campaign actions.
 *
 * Every legacy query selecting rows by client — or sweeping the whole table —
 * must carry `LEGACY_CALENDAR`, because a client-scoped filter alone matches
 * both kinds. Without it, "queue all" would render campaign days through the
 * legacy pipeline straight into `gDriveFileId`, "clear calendar" would delete
 * them, and a delivery-day change would move their dates. For every row that
 * existed before campaigns, `campaignId` is null, so the scope changes nothing
 * about their behaviour.
 */
export const LEGACY_CALENDAR = { campaignId: null } satisfies Prisma.ContentCalendarWhereInput;

/** Operator copy for a legacy action pointed at one campaign day. */
export const CAMPAIGN_DAY_REFUSAL =
  'This day belongs to a campaign. Campaign days are changed only by campaign actions, not by the legacy calendar tools.';

/** Operator copy for a legacy calendar writer pointed at a client whose calendar holds campaign days. */
export function campaignCalendarRefusal(companyName: string, campaignDays: number): string {
  return (
    `${companyName}'s calendar holds ${campaignDays} campaign day(s). The legacy calendar tools ` +
    '(seed, sheet import, manual upload) do not write into a campaign calendar — use campaign actions instead.'
  );
}

/**
 * Campaign days in one client's calendar.
 *
 * The legacy writers that fill a calendar by day number — seeding, sheet
 * import, manual upload — refuse a client for whom this is non-zero: they read
 * occupied days client-wide, so they would either rewrite a campaign day or
 * interleave legacy days into the campaign's numbering, which the legacy sweep
 * would then deliver.
 */
export function countCampaignDays(clientId: string): Promise<number> {
  return prisma.contentCalendar.count({ where: { clientId, campaignId: { not: null } } });
}

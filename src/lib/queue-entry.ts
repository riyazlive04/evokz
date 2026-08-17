import type { DeliveryStatus } from '@prisma/client';

import type { QueueEntry } from '@/components/admin/QueueLedger';
import { buildThumbnailUrl } from '@/lib/google-drive';
import { formatDisplayDate, formatDisplayDateTime } from '@/lib/time';

/**
 * Shared `ContentCalendar` projection for every surface that renders a
 * `QueueLedger` — the dashboard feed and the per-client ledger read the same
 * columns, so the select and its row mapper live together.
 */

/**
 * Width requested for the click-through view.
 *
 * Above every output preset in the catalogue, so the content host returns the
 * stored file untouched rather than a downscale. It does not upscale, so asking
 * for more than a poster has costs nothing.
 */
const FULL_SIZE_WIDTH = 2048;

export const queueSelect = {
  id: true,
  dayNumber: true,
  scheduledDate: true,
  theme: true,
  caption: true,
  hashtags: true,
  deliveryStatus: true,
  sendAfter: true,
  approvedAt: true,
  gDriveFileId: true,
  gDriveViewUrl: true,
  errorMessage: true,
  client: { select: { companyName: true, whatsappNumber: true, cronTime: true } },
} as const;

export interface QueueRecord {
  id: string;
  dayNumber: number;
  scheduledDate: Date;
  theme: string;
  caption: string;
  hashtags: string;
  deliveryStatus: DeliveryStatus;
  sendAfter: Date | null;
  approvedAt: Date | null;
  gDriveFileId: string | null;
  gDriveViewUrl: string | null;
  errorMessage: string | null;
  client: { companyName: string; whatsappNumber: string; cronTime: string };
}

/**
 * @param thumbnailWidth Drive thumbnail width in pixels. The default suits the
 *   scanning grid; the approval surface asks for more, because deciding whether a
 *   headline sits badly is not a judgement anyone can make at 512px.
 */
export function toQueueEntry(
  entry: QueueRecord,
  timeZone: string,
  thumbnailWidth?: number,
): QueueEntry {
  return {
    id: entry.id,
    companyName: entry.client.companyName,
    whatsappNumber: entry.client.whatsappNumber,
    cronTime: entry.client.cronTime,
    dayNumber: entry.dayNumber,
    theme: entry.theme,
    caption: entry.caption,
    hashtags: entry.hashtags,
    scheduledLabel: formatDisplayDate(entry.scheduledDate, timeZone),
    status: entry.deliveryStatus,
    // Only meaningful while the poster is waiting out its send delay. A row that
    // already went out has this cleared, and one that failed is described by its
    // errorMessage instead — so the label is never stale.
    sendAfterLabel:
      entry.sendAfter && entry.deliveryStatus === 'GENERATED'
        ? formatDisplayDateTime(entry.sendAfter, timeZone)
        : null,
    // The other reason a poster can exist without going out, and the one an
    // operator can do something about. Mutually exclusive with `sendAfterLabel`
    // by construction: booking a send is what approval leads to.
    awaitingApproval: entry.approvedAt === null && entry.deliveryStatus === 'GENERATED',
    // Approved, but no send booked yet — normally a poster waiting for a day that
    // has not arrived. Once `sendAfter` is set a sweep may already have claimed
    // the row, so offering an undo past that point would promise something this
    // console cannot deliver.
    canWithdrawApproval:
      entry.approvedAt !== null &&
      entry.sendAfter === null &&
      entry.deliveryStatus === 'GENERATED',
    // Prefer the cheap Drive thumbnail endpoint over the full-size download.
    thumbnailUrl: entry.gDriveFileId
      ? buildThumbnailUrl(entry.gDriveFileId, thumbnailWidth)
      : entry.gDriveViewUrl,
    /*
     * The same content host, asked for more pixels than any poster has. It
     * serves the stored file rather than upscaling, so this is the creative at
     * its native size — 1080 wide today — and stays correct if a client is moved
     * to a larger output preset.
     */
    fullUrl: entry.gDriveFileId
      ? buildThumbnailUrl(entry.gDriveFileId, FULL_SIZE_WIDTH)
      : entry.gDriveViewUrl,
    viewUrl: entry.gDriveViewUrl,
    errorMessage: entry.errorMessage,
  };
}

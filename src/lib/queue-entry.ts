import type { DeliveryStatus } from '@prisma/client';

import type { QueueEntry } from '@/components/admin/QueueLedger';
import { buildThumbnailUrl } from '@/lib/google-drive';
import { formatDisplayDate, formatDisplayDateTime } from '@/lib/time';

/**
 * Shared `ContentCalendar` projection for every surface that renders a
 * `QueueLedger` — the dashboard feed and the per-client ledger read the same
 * columns, so the select and its row mapper live together.
 */

export const queueSelect = {
  id: true,
  dayNumber: true,
  scheduledDate: true,
  theme: true,
  caption: true,
  hashtags: true,
  deliveryStatus: true,
  sendAfter: true,
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
  gDriveFileId: string | null;
  gDriveViewUrl: string | null;
  errorMessage: string | null;
  client: { companyName: string; whatsappNumber: string; cronTime: string };
}

export function toQueueEntry(entry: QueueRecord, timeZone: string): QueueEntry {
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
    // Prefer the cheap Drive thumbnail endpoint over the full-size download.
    thumbnailUrl: entry.gDriveFileId
      ? buildThumbnailUrl(entry.gDriveFileId)
      : entry.gDriveViewUrl,
    viewUrl: entry.gDriveViewUrl,
    errorMessage: entry.errorMessage,
  };
}

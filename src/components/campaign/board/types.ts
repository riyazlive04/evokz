import type { BoardCounts, BoardDayActions, BoardFilter, BoardStatus, SlotLock } from '@/lib/campaign/board';

/**
 * The campaign board's view model: what the server page hands the client board.
 *
 * Plain strings, numbers and booleans only — every date is formatted on the
 * server in the app timezone, so the browser never re-derives a local date (and
 * a viewer in another zone sees the same day the delivery sweep uses).
 */

export type CampaignStatusView = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
export type ApprovalPolicyView = 'MANUAL_REVIEW' | 'AUTO_APPROVE';

export interface BoardDayView {
  id: string;
  dayNumber: number;
  /** "Thu 17 Sept" */
  dateLabel: string;
  isToday: boolean;
  headline: string | null;
  template: { label: string; thumbnailUrl: string } | null;
  poster: {
    versionId: string;
    versionNumber: number;
    /** The final poster through the protected route; null for a manual upload. */
    imageUrl: string | null;
    approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
    current: boolean;
    source?: 'PIPELINE' | 'POSTER_STUDIO' | 'MANUAL_UPLOAD';
  } | null;
  textCheckIssues: number;
  status: BoardStatus;
  statusLabel: string;
  delivery: {
    status: 'SCHEDULED' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED' | 'SKIPPED';
    statusLabel: string;
    /** "09:04" in the app timezone. */
    timeLabel: string;
    /** "17 Sept, 09:04" */
    whenLabel: string;
    attempts: number;
    failureReason: string | null;
    failurePermanent: boolean;
    /** The booking carries the active poster (a stale pin is not shown as this day's delivery). */
    pinnedToActive: boolean;
  } | null;
  lock: SlotLock | null;
  lockLabel: string | null;
  note: { tone: 'danger' | 'warning' | 'muted'; text: string } | null;
  actions: BoardDayActions;
  /** Caption and Link sent with the poster, and internal Notes that never are. */
  message: {
    caption: string;
    link: string | null;
    notes: string | null;
    shown: boolean;
    editable: boolean;
    lockedReason: string | null;
  };
}

export interface BoardView {
  campaignId: string;
  campaignName: string;
  clientId: string;
  clientName: string;
  categoryName: string;
  status: CampaignStatusView;
  approvalPolicy: ApprovalPolicyView;
  closed: boolean;
  /** "17 Sept 2026 → 16 Oct 2026" */
  datesLabel: string;
  /** "30 days · Every day at 09:00" */
  scheduleLabel: string;
  counts: BoardCounts;
  filter: BoardFilter;
  q: string;
  mode: 'week' | 'filtered';
  page: { index: number; count: number; label: string; todayIndex: number; matching: number };
  totalDays: number;
  /** Days of the whole campaign waiting in the generation queue (QUEUED) — what "Resume generating" drains. */
  queuedCount: number;
  days: BoardDayView[];
  warnings: string[];
}

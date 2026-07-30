import { DeliveryStatus } from '@prisma/client';

import { Badge, type BadgeProps } from '@/components/ui/badge';

/** Explicit status -> colour mapping for the delivery pipeline. */
const STATUS_VARIANT: Record<DeliveryStatus, NonNullable<BadgeProps['variant']>> = {
  [DeliveryStatus.PENDING]: 'slate',
  [DeliveryStatus.GENERATED]: 'amber',
  [DeliveryStatus.DELIVERED]: 'emerald',
  [DeliveryStatus.FAILED]: 'destructive',
};

// One step darker than the badge tint they sit on, so the dot stays legible
// against the light body.
const STATUS_DOT: Record<DeliveryStatus, string> = {
  [DeliveryStatus.PENDING]: 'bg-muted-foreground',
  [DeliveryStatus.GENERATED]: 'bg-amber-500',
  [DeliveryStatus.DELIVERED]: 'bg-emerald-500',
  [DeliveryStatus.FAILED]: 'bg-red-500',
};

export function StatusBadge({ status }: { status: DeliveryStatus }) {
  return (
    <Badge variant={STATUS_VARIANT[status]}>
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`}
      />
      {status}
    </Badge>
  );
}

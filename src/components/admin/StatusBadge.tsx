import { DeliveryStatus } from '@prisma/client';

import { Badge, type BadgeProps } from '@/components/ui/badge';

/** Explicit status -> colour mapping for the delivery pipeline. */
const STATUS_VARIANT: Record<DeliveryStatus, NonNullable<BadgeProps['variant']>> = {
  [DeliveryStatus.PENDING]: 'slate',
  [DeliveryStatus.GENERATED]: 'amber',
  [DeliveryStatus.DELIVERED]: 'emerald',
  [DeliveryStatus.FAILED]: 'destructive',
};

// The solid status fill, which reads a step stronger than the /10 tint of the
// badge it sits inside. Both sides are per-theme tokens, so the pairing holds
// in light and dark without a `dark:` variant.
const STATUS_DOT: Record<DeliveryStatus, string> = {
  [DeliveryStatus.PENDING]: 'bg-muted-foreground',
  [DeliveryStatus.GENERATED]: 'bg-warning',
  [DeliveryStatus.DELIVERED]: 'bg-success',
  [DeliveryStatus.FAILED]: 'bg-danger',
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

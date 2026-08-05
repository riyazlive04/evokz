import * as React from 'react';

import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider transition-colors focus:outline-none',
  {
    variants: {
      variant: {
        default: 'border-primary/25 bg-primary/15 text-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        slate: 'border-border bg-muted text-muted-foreground',
        // Status tints. The `-ink` token is the ink for a status colour sitting
        // on a page surface; it is retuned per theme, which is why no `dark:`
        // override is needed — one class is correct in both modes.
        destructive: 'border-danger/25 bg-danger/10 text-danger-ink',
        amber: 'border-warning/25 bg-warning/10 text-warning-ink',
        emerald: 'border-success/25 bg-success/10 text-success-ink',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };

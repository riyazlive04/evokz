import * as React from 'react';

import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider transition-colors focus:outline-none',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/15 text-primary',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        // Status tints read on the light body, so the text steps down to the
        // -700 ramp; the -400 ink these used to carry was tuned for the old
        // dark-only shell and fails contrast on white.
        destructive: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400',
        outline: 'border-border text-foreground',
        slate: 'border-border bg-muted text-muted-foreground',
        amber: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400',
        emerald: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
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

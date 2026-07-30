/**
 * Per-section title block. The global chrome lives in the admin layout, so a
 * page only declares what it is and which actions it offers.
 */
export function PageHeader({
  icon: Icon,
  eyebrow,
  title,
  description,
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned actions. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 space-y-1">
        {eyebrow && (
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            {eyebrow}
          </p>
        )}
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
          {Icon && <Icon className="h-5 w-5 shrink-0 text-brand-to" />}
          {title}
        </h1>
        {description && (
          <p className="max-w-3xl text-xs text-muted-foreground">{description}</p>
        )}
      </div>

      {children && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
      )}
    </div>
  );
}

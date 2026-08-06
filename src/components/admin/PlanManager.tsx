'use client';

import * as React from 'react';

import { Check, Loader2, Minus, Pencil, Plus, Trash2, X } from 'lucide-react';

import { createPlan, deletePlan, updatePlan } from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAction } from '@/hooks/use-action';

export interface PlanRow {
  id: string;
  name: string;
  durationDays: number;
  clientCount: number;
  /** Campaign fee in whole rupees; null when the plan has not been priced. */
  priceInr: number | null;
}

/** Blank input means "unpriced", which is distinct from a zero-rupee plan. */
function parsePrice(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const DURATION_PRESETS = [30, 100, 180, 365] as const;

export function PlanManager({ plans }: { plans: PlanRow[] }) {
  const [name, setName] = React.useState('');
  const [durationDays, setDurationDays] = React.useState(100);
  const [price, setPrice] = React.useState('');
  const create = useAction(createPlan);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    const result = await create.run({
      name,
      durationDays,
      priceInr: parsePrice(price),
    });
    if (result.ok) {
      setName('');
      setDurationDays(100);
      setPrice('');
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleCreate} className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
        <div className="space-y-1.5">
          <Label htmlFor="plan-name">Plan name</Label>
          <Input
            id="plan-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="365-Day Scale"
            maxLength={120}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="plan-duration">Duration (days)</Label>
          <DurationStepper
            id="plan-duration"
            value={durationDays}
            onChange={setDurationDays}
            disabled={create.pending}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="plan-price">Fee (₹)</Label>
          <Input
            id="plan-price"
            type="number"
            inputMode="numeric"
            min={0}
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            placeholder="Unpriced"
            className="w-28 text-right font-mono"
          />
        </div>

        <div className="flex items-end">
          <Button type="submit" disabled={create.pending} className="w-full sm:w-auto">
            {create.pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Add plan
          </Button>
        </div>
      </form>

      <div className="flex flex-wrap gap-2">
        {DURATION_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setDurationDays(preset)}
            className="inline-flex min-h-[28px] items-center rounded-full border border-border px-3 py-1 text-[11px] text-muted-foreground transition-colors duration-200 hover:border-primary/40 hover:text-foreground sm:min-h-0"
          >
            {preset}d
          </button>
        ))}
      </div>

      {create.error && <ErrorLine message={create.error} />}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Plan</TableHead>
            <TableHead className="w-40">Duration</TableHead>
            <TableHead className="w-32 text-right">Fee (₹)</TableHead>
            <TableHead className="w-20 text-right">Clients</TableHead>
            <TableHead className="w-32 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plans.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-6 text-center text-xs text-muted-foreground">
                No plans configured yet.
              </TableCell>
            </TableRow>
          ) : (
            plans.map((plan) => <PlanRowItem key={plan.id} plan={plan} />)
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function PlanRowItem({ plan }: { plan: PlanRow }) {
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(plan.name);
  const [durationDays, setDurationDays] = React.useState(plan.durationDays);
  const [price, setPrice] = React.useState(plan.priceInr?.toString() ?? '');
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const update = useAction(updatePlan);
  const remove = useAction(deletePlan);

  // Re-sync when the server sends fresh props after revalidation.
  React.useEffect(() => {
    if (!editing) {
      setName(plan.name);
      setDurationDays(plan.durationDays);
      setPrice(plan.priceInr?.toString() ?? '');
    }
  }, [editing, plan.name, plan.durationDays, plan.priceInr]);

  async function handleSave() {
    const result = await update.run(plan.id, {
      name,
      durationDays,
      priceInr: parsePrice(price),
    });
    if (result.ok) setEditing(false);
  }

  function handleCancel() {
    setName(plan.name);
    setDurationDays(plan.durationDays);
    setPrice(plan.priceInr?.toString() ?? '');
    update.reset();
    setEditing(false);
  }

  return (
    <>
      <TableRow>
        <TableCell>
          {editing ? (
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              aria-label="Plan name"
            />
          ) : (
            <span className="font-medium text-foreground">{plan.name}</span>
          )}
        </TableCell>

        <TableCell>
          {editing ? (
            <DurationStepper
              value={durationDays}
              onChange={setDurationDays}
              disabled={update.pending}
            />
          ) : (
            <span className="font-mono text-sm text-muted-foreground">{plan.durationDays} days</span>
          )}
        </TableCell>

        <TableCell className="text-right">
          {editing ? (
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              placeholder="Unpriced"
              disabled={update.pending}
              className="w-28 text-right font-mono"
              aria-label="Campaign fee in rupees"
            />
          ) : plan.priceInr === null ? (
            <span className="text-xs text-warning-ink" title="Margin cannot be computed">
              unpriced
            </span>
          ) : (
            <span className="font-mono text-sm tabular-nums text-foreground">
              ₹{plan.priceInr.toLocaleString('en-IN')}
            </span>
          )}
        </TableCell>

        <TableCell className="text-right font-mono text-sm text-muted-foreground">
          {plan.clientCount}
        </TableCell>

        <TableCell>
          <div className="flex items-center justify-end gap-1">
            {editing ? (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleSave}
                  disabled={update.pending}
                  aria-label="Save plan"
                >
                  {update.pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4 text-success-ink" />
                  )}
                </Button>
                <Button size="icon" variant="ghost" onClick={handleCancel} aria-label="Cancel">
                  <X className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setEditing(true)}
                  aria-label={`Edit ${plan.name}`}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    confirmDelete ? void remove.run(plan.id) : setConfirmDelete(true)
                  }
                  disabled={remove.pending}
                  aria-label={confirmDelete ? `Confirm delete ${plan.name}` : `Delete ${plan.name}`}
                  className={confirmDelete ? 'text-danger-ink' : ''}
                >
                  {remove.pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              </>
            )}
          </div>
        </TableCell>
      </TableRow>

      {(update.error || remove.error || confirmDelete) && (
        <TableRow>
          <TableCell colSpan={5} className="pt-0">
            {confirmDelete && !remove.error && (
              <div className="flex items-center gap-3 text-[11px] text-warning-ink">
                Click delete again to confirm.
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
              </div>
            )}
            {update.error && <ErrorLine message={update.error} />}
            {remove.error && <ErrorLine message={remove.error} />}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** Numeric input with coarse steppers — faster than typing for day counts. */
function DurationStepper({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const clamp = (next: number) => Math.min(3650, Math.max(1, next));

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="h-9 w-9 shrink-0"
        onClick={() => onChange(clamp(value - 5))}
        disabled={disabled}
        aria-label="Decrease duration by 5 days"
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={3650}
        value={value}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          onChange(Number.isFinite(parsed) ? clamp(parsed) : 1);
        }}
        disabled={disabled}
        className="w-20 text-center font-mono"
        aria-label="Duration in days"
      />
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="h-9 w-9 shrink-0"
        onClick={() => onChange(clamp(value + 5))}
        disabled={disabled}
        aria-label="Increase duration by 5 days"
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" className="text-[11px] text-danger-ink">
      {message}
    </p>
  );
}

'use client';

import * as React from 'react';

import { Check, Loader2, Undo2 } from 'lucide-react';

import {
  updateClientCategory,
  updateClientDeliveryDays,
  updateClientPlan,
} from '@/app/admin/dashboard/actions';
import { DeliveryDaysPicker } from '@/components/admin/DeliveryDaysPicker';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAction } from '@/hooks/use-action';

/**
 * Reassigns a client's plan and vertical after onboarding.
 *
 * These used to be presented as immutable, but nothing enforced it — the real
 * constraint is narrower: a plan can only shrink once the surplus calendar days
 * are gone, because the dispatcher filters on the campaign window and stranded
 * days would silently never deliver. The server action refuses that case and
 * says how many days are in the way; clearing the calendar is the way through.
 */
export function ClientAssignment({
  clientId,
  planId,
  categoryId,
  deliveryDays,
  plans,
  categories,
  hasCalendar,
}: {
  clientId: string;
  planId: string;
  categoryId: string;
  /** ISO weekdays; empty means every day. */
  deliveryDays: number[];
  plans: Array<{ id: string; name: string; durationDays: number }>;
  categories: Array<{ id: string; name: string }>;
  /** Drives the warning that saving weekdays will move existing rows. */
  hasCalendar: boolean;
}) {
  const planAction = useAction(updateClientPlan);
  const categoryAction = useAction(updateClientCategory);
  const daysAction = useAction(updateClientDeliveryDays);

  const [nextPlan, setNextPlan] = React.useState(planId);
  const [nextCategory, setNextCategory] = React.useState(categoryId);
  const [nextDays, setNextDays] = React.useState<number[]>(deliveryDays);
  const [flash, setFlash] = React.useState<string | null>(null);

  React.useEffect(() => setNextPlan(planId), [planId]);
  React.useEffect(() => setNextCategory(categoryId), [categoryId]);
  React.useEffect(() => setNextDays(deliveryDays), [deliveryDays]);

  React.useEffect(() => {
    if (flash === null) return undefined;
    const timer = setTimeout(() => setFlash(null), 5_000);
    return () => clearTimeout(timer);
  }, [flash]);

  const planDirty = nextPlan !== planId;
  const categoryDirty = nextCategory !== categoryId;
  const daysDirty = [...nextDays].sort().join() !== [...deliveryDays].sort().join();

  async function savePlan() {
    const result = await planAction.run(clientId, nextPlan);
    if (result.ok) {
      setFlash(`Plan changed — campaign window now runs ${result.data.durationDays} days.`);
    } else {
      setNextPlan(planId);
    }
  }

  async function saveCategory() {
    const result = await categoryAction.run(clientId, nextCategory);
    if (result.ok) setFlash('Vertical updated. Days already seeded keep their old copy.');
    else setNextCategory(categoryId);
  }

  async function saveDays() {
    const result = await daysAction.run(clientId, nextDays);
    if (result.ok) {
      const { rescheduled, kept, endsOn, label } = result.data;
      setFlash(
        `Delivering ${label}. ${rescheduled} upcoming day(s) moved` +
          (kept > 0 ? `, ${kept} already-sent day(s) untouched` : '') +
          `. Campaign now ends ${endsOn}.`,
      );
    } else {
      setNextDays(deliveryDays);
    }
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="client-plan">Plan</Label>
          <div className="flex items-center gap-1.5">
            <Select value={nextPlan} onValueChange={setNextPlan}>
              <SelectTrigger id="client-plan" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {plans.map((plan) => (
                  <SelectItem key={plan.id} value={plan.id}>
                    {plan.name} · {plan.durationDays}d
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {planDirty && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={savePlan}
                  disabled={planAction.pending}
                  aria-label="Save plan"
                >
                  {planAction.pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4 text-success-ink" />
                  )}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setNextPlan(planId)}
                  aria-label="Revert plan"
                >
                  <Undo2 className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="client-vertical">Vertical</Label>
          <div className="flex items-center gap-1.5">
            <Select value={nextCategory} onValueChange={setNextCategory}>
              <SelectTrigger id="client-vertical" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {categoryDirty && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={saveCategory}
                  disabled={categoryAction.pending}
                  aria-label="Save vertical"
                >
                  {categoryAction.pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4 text-success-ink" />
                  )}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setNextCategory(categoryId)}
                  aria-label="Revert vertical"
                >
                  <Undo2 className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-1.5 border-t border-border pt-4">
        <div className="flex flex-wrap items-end gap-3">
          <DeliveryDaysPicker
            id="client-delivery-days"
            value={nextDays}
            onChange={setNextDays}
            disabled={daysAction.pending}
          />

          {daysDirty && (
            <div className="flex items-center gap-1.5 pb-1">
              <Button
                size="icon"
                variant="ghost"
                onClick={saveDays}
                disabled={daysAction.pending}
                aria-label="Save delivery days"
              >
                {daysAction.pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4 text-success-ink" />
                )}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setNextDays(deliveryDays)}
                aria-label="Revert delivery days"
              >
                <Undo2 className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        <p className="text-[10px] text-muted-foreground">
          All plan days are still delivered — restricted weekdays spread the campaign
          wider and move the end date.
          {hasCalendar && daysDirty && (
            <span className="text-warning-ink">
              {' '}
              Saving reschedules every upcoming day; already-sent days keep their dates.
            </span>
          )}
        </p>
      </div>

      <p className="text-[10px] text-muted-foreground">
        Changing the plan moves the campaign end date. A shorter plan is refused while
        calendar days fall beyond it — clear those days first.
      </p>

      {flash && (
        <p className="flex items-center gap-1.5 text-[11px] text-success-ink">
          <Check className="h-3.5 w-3.5" />
          {flash}
        </p>
      )}

      {(planAction.error ?? categoryAction.error) && (
        <p role="alert" className="text-[11px] text-danger-ink">
          {planAction.error ?? categoryAction.error}
        </p>
      )}
    </div>
  );
}

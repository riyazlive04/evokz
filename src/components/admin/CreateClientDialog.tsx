'use client';

import * as React from 'react';

import { AlertTriangle, Loader2, UserPlus } from 'lucide-react';

import { createClientManually } from '@/app/admin/dashboard/actions';
import { ImageSizeSelect } from '@/components/admin/ImageSizeSelect';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAction } from '@/hooks/use-action';
import { DEFAULT_IMAGE_SIZE_ID } from '@/lib/image-sizes';

export interface OptionRow {
  id: string;
  name: string;
  durationDays?: number;
}

/**
 * Manual onboarding: runs the same provisioning routine as the Razorpay
 * webhook (campaign window + Drive folder), bypassing the payment gateway.
 */
export function CreateClientDialog({
  plans,
  categories,
  demo = false,
}: {
  plans: OptionRow[];
  categories: OptionRow[];
  /**
   * Provisions a demo tenant instead of a client. Same provisioning path — the
   * row is flagged `isDemo`, which keeps it out of the client matrix and out of
   * the cron sweep.
   */
  demo?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [companyName, setCompanyName] = React.useState('');
  const [whatsappNumber, setWhatsappNumber] = React.useState('');
  const [planId, setPlanId] = React.useState('');
  const [categoryId, setCategoryId] = React.useState('');
  const [cronTime, setCronTime] = React.useState('09:00');
  // Pre-selected rather than blank: the spec-correct shape should be what an
  // operator has to deliberately move away from, not what they have to find.
  const [imageSizePreset, setImageSizePreset] = React.useState(DEFAULT_IMAGE_SIZE_ID);
  const [warning, setWarning] = React.useState<string | null>(null);

  const create = useAction(createClientManually);
  const canSubmit = Boolean(companyName && whatsappNumber && planId && categoryId);
  const selectedPlan = plans.find((plan) => plan.id === planId);

  function resetForm() {
    setCompanyName('');
    setWhatsappNumber('');
    setPlanId('');
    setCategoryId('');
    setCronTime('09:00');
    setImageSizePreset(DEFAULT_IMAGE_SIZE_ID);
    setWarning(null);
    create.reset();
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setWarning(null);

    const result = await create.run({
      companyName,
      whatsappNumber,
      planId,
      categoryId,
      cronTime,
      isDemo: demo,
      imageSizePreset: imageSizePreset || null,
    });

    if (!result.ok) return;

    if (result.data.driveWarning) {
      // The client exists but Drive provisioning failed — keep the dialog open
      // so the operator sees why, and repair from the client matrix.
      setWarning(result.data.driveWarning);
      return;
    }

    resetForm();
    setOpen(false);
  }

  const blocked = plans.length === 0 || categories.length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetForm();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" disabled={blocked} title={blocked ? 'Create a plan and a vertical first' : undefined}>
          <UserPlus className="h-4 w-4" />
          {demo ? 'New demo tenant' : 'Manual onboarding'}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{demo ? 'New demo tenant' : 'Manual client onboarding'}</DialogTitle>
          <DialogDescription>
            {demo
              ? 'Provisioned exactly like a client — campaign window from the plan duration, isolated Drive folder — but excluded from the dispatch sweep, so it only ever sends when you press the button.'
              : 'Bypasses Razorpay. Calculates the campaign window from the plan duration and provisions the client’s isolated Google Drive folder.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-company">Company name</Label>
              <Input
                id="new-company"
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                placeholder="Skyline Realty"
                required
                maxLength={160}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-whatsapp">WhatsApp number</Label>
              <Input
                id="new-whatsapp"
                value={whatsappNumber}
                onChange={(event) => setWhatsappNumber(event.target.value)}
                placeholder="919876543210"
                inputMode="tel"
                required
              />
              <p className="text-[10px] text-muted-foreground">
                International format without “+”. A bare 10-digit number is treated as +91.
                {demo ? ' Demo creatives are WhatsApped to this number on demand.' : ''}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-plan">Plan</Label>
              <Select value={planId} onValueChange={setPlanId}>
                <SelectTrigger id="new-plan">
                  <SelectValue placeholder="Select a plan" />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name}
                      {plan.durationDays ? ` · ${plan.durationDays}d` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-category">Business vertical</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger id="new-category">
                  <SelectValue placeholder="Select a vertical" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-cron">Daily delivery time</Label>
              <Input
                id="new-cron"
                type="time"
                step={60}
                value={cronTime}
                onChange={(event) => setCronTime(event.target.value)}
                className="font-mono"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label>Campaign window</Label>
              <p className="flex h-9 items-center font-mono text-xs text-muted-foreground">
                {selectedPlan?.durationDays
                  ? `today → +${selectedPlan.durationDays} days`
                  : '— select a plan —'}
              </p>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="new-image-size">Creative output size</Label>
              <ImageSizeSelect
                id="new-image-size"
                value={imageSizePreset}
                onChange={setImageSizePreset}
              />
            </div>
          </div>

          {create.error && (
            <p role="alert" className="text-xs text-red-600">
              {create.error}
            </p>
          )}

          {warning && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {demo ? 'Demo tenant' : 'Client'} created, but the Google Drive folder could
                not be provisioned: {warning}. Use “Provision folder” once Drive access is
                fixed.
              </span>
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                resetForm();
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || create.pending}>
              {create.pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="h-4 w-4" />
              )}
              {demo ? 'Provision demo tenant' : 'Provision client'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import * as React from 'react';

import { Check, FolderCheck, Loader2, Pause, Play, Undo2 } from 'lucide-react';

import {
  repairDriveFolder,
  setClientActive,
  updateClientBudget,
  updateClientCronTime,
  updateClientImageSize,
} from '@/app/admin/dashboard/actions';
import { ImageSizeSelect } from '@/components/admin/ImageSizeSelect';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAction } from '@/hooks/use-action';

/**
 * The mutating controls for a single client, laid out for the detail page.
 *
 * Same three server actions the client matrix drives inline; this variant has
 * room for labels, so it is the surface an operator reaches for deliberately.
 */
/** Blank means "no cap", which is distinct from a ₹0 cap. */
function parseBudget(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function ClientControls({
  clientId,
  companyName,
  cronTime: savedCronTime,
  isActive,
  hasDriveFolder,
  timeZone,
  monthlyBudgetInr: savedBudget = null,
  imageSizePreset: savedImageSize = null,
}: {
  clientId: string;
  companyName: string;
  cronTime: string;
  isActive: boolean;
  hasDriveFolder: boolean;
  timeZone: string;
  /** Current monthly spend cap in rupees; null disables the alert. */
  monthlyBudgetInr?: number | null;
  /** Stored output-size preset id; null means the fleet default. */
  imageSizePreset?: string | null;
}) {
  const cronAction = useAction(updateClientCronTime);
  const activeAction = useAction(setClientActive);
  const driveAction = useAction(repairDriveFolder);
  const budgetAction = useAction(updateClientBudget);
  const imageSizeAction = useAction(updateClientImageSize);

  const [cronTime, setCronTime] = React.useState(savedCronTime);
  const [budget, setBudget] = React.useState(savedBudget?.toString() ?? '');
  const [imageSize, setImageSize] = React.useState(savedImageSize ?? '');
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [budgetSavedAt, setBudgetSavedAt] = React.useState<number | null>(null);
  const [imageSizeSavedAt, setImageSizeSavedAt] = React.useState<number | null>(null);

  React.useEffect(() => {
    setCronTime(savedCronTime);
  }, [savedCronTime]);

  React.useEffect(() => {
    setBudget(savedBudget?.toString() ?? '');
  }, [savedBudget]);

  React.useEffect(() => {
    setImageSize(savedImageSize ?? '');
  }, [savedImageSize]);

  React.useEffect(() => {
    if (budgetSavedAt === null) return undefined;
    const timer = setTimeout(() => setBudgetSavedAt(null), 2_000);
    return () => clearTimeout(timer);
  }, [budgetSavedAt]);

  React.useEffect(() => {
    if (imageSizeSavedAt === null) return undefined;
    const timer = setTimeout(() => setImageSizeSavedAt(null), 2_000);
    return () => clearTimeout(timer);
  }, [imageSizeSavedAt]);

  // Clear the "saved" flash without leaving a timer behind on unmount.
  React.useEffect(() => {
    if (savedAt === null) return undefined;
    const timer = setTimeout(() => setSavedAt(null), 2_000);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const dirty = cronTime !== savedCronTime;
  const budgetDirty = parseBudget(budget) !== savedBudget;
  const imageSizeDirty = (imageSize || null) !== savedImageSize;

  async function handleSaveCron() {
    const result = await cronAction.run(clientId, cronTime);
    if (result.ok) setSavedAt(Date.now());
  }

  async function handleSaveBudget() {
    const result = await budgetAction.run(clientId, parseBudget(budget));
    if (result.ok) setBudgetSavedAt(Date.now());
  }

  async function handleSaveImageSize() {
    const result = await imageSizeAction.run(clientId, imageSize || null);
    if (result.ok) setImageSizeSavedAt(Date.now());
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-4 sm:gap-x-6">
        <div className="space-y-1.5">
          <Label htmlFor="client-cron-time">Delivery time ({timeZone})</Label>
          <div className="flex items-center gap-1.5">
            <Input
              id="client-cron-time"
              type="time"
              value={cronTime}
              step={60}
              onChange={(event) => setCronTime(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && dirty) {
                  event.preventDefault();
                  void handleSaveCron();
                }
                if (event.key === 'Escape') setCronTime(savedCronTime);
              }}
              className="w-32 font-mono"
            />

            {dirty && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleSaveCron}
                  disabled={cronAction.pending}
                  aria-label="Save delivery time"
                >
                  {cronAction.pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4 text-success-ink" />
                  )}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setCronTime(savedCronTime)}
                  aria-label="Revert delivery time"
                >
                  <Undo2 className="h-4 w-4" />
                </Button>
              </>
            )}

            {savedAt !== null && !dirty && (
              <span className="text-[11px] text-success-ink">Saved</span>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Dispatch state</Label>
          <Button
            variant="outline"
            onClick={() => void activeAction.run(clientId, !isActive)}
            disabled={activeAction.pending}
          >
            {activeAction.pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isActive ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {isActive ? 'Pause campaign' : 'Resume campaign'}
          </Button>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="client-budget">Monthly spend cap (₹)</Label>
          <div className="flex items-center gap-1.5">
            <Input
              id="client-budget"
              type="number"
              inputMode="numeric"
              min={0}
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && budgetDirty) {
                  event.preventDefault();
                  void handleSaveBudget();
                }
                if (event.key === 'Escape') setBudget(savedBudget?.toString() ?? '');
              }}
              placeholder="No cap"
              className="w-28 text-right font-mono"
            />

            {budgetDirty && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleSaveBudget}
                  disabled={budgetAction.pending}
                  aria-label="Save spend cap"
                >
                  {budgetAction.pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4 text-success-ink" />
                  )}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setBudget(savedBudget?.toString() ?? '')}
                  aria-label="Revert spend cap"
                >
                  <Undo2 className="h-4 w-4" />
                </Button>
              </>
            )}

            {budgetSavedAt !== null && !budgetDirty && (
              <span className="text-[11px] text-success-ink">Saved</span>
            )}
          </div>
        </div>

        {!hasDriveFolder && (
          <div className="space-y-1.5">
            <Label>Drive vault</Label>
            <Button
              variant="outline"
              onClick={() => void driveAction.run(clientId)}
              disabled={driveAction.pending}
            >
              {driveAction.pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FolderCheck className="h-4 w-4" />
              )}
              Provision folder
            </Button>
          </div>
        )}
      </div>

      <div className="max-w-sm space-y-1.5 border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <Label htmlFor="client-image-size">Creative output size</Label>
          {imageSizeDirty && (
            <>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={handleSaveImageSize}
                disabled={imageSizeAction.pending}
                aria-label="Save output size"
              >
                {imageSizeAction.pending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5 text-success-ink" />
                )}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => setImageSize(savedImageSize ?? '')}
                aria-label="Revert output size"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          {imageSizeSavedAt !== null && !imageSizeDirty && (
            <span className="text-[11px] text-success-ink">Saved</span>
          )}
        </div>

        <ImageSizeSelect
          id="client-image-size"
          value={imageSize}
          onChange={setImageSize}
          disabled={imageSizeAction.pending}
        />

        <p className="text-[10px] text-muted-foreground">
          Applies from the next render on. Days already generated keep the asset they
          were rendered at — regenerate those individually to re-shape them.
        </p>
      </div>

      {!hasDriveFolder && (
        <p className="text-[11px] text-danger-ink">
          {companyName} has no Drive folder — the pipeline cannot deliver until one exists.
        </p>
      )}

      {[
        cronAction.error,
        activeAction.error,
        driveAction.error,
        budgetAction.error,
        imageSizeAction.error,
      ]
        .filter((message): message is string => Boolean(message))
        .map((message) => (
          <p key={message} role="alert" className="text-[11px] text-danger-ink">
            {message}
          </p>
        ))}
    </div>
  );
}

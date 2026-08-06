'use client';

import * as React from 'react';

import { AlertTriangle, Loader2, Pencil } from 'lucide-react';

import { updateClientProfile } from '@/app/admin/dashboard/actions';
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
import { useAction } from '@/hooks/use-action';

/**
 * Edits the two tenant facts written at onboarding.
 *
 * Everything else a client owns is edited where it is used — delivery time,
 * spend cap and output size in `ClientControls`, plan and vertical in
 * `ClientAssignment`, the poster contact bar on the brand canvas. These two had
 * no editor at all: in the normal flow they come from a Razorpay checkout, so a
 * customer's typo in their own company name was permanent.
 *
 * The number is not just a label — it is where the creatives are sent — so the
 * dialog says so rather than presenting it as an ordinary text field.
 */
export function EditClientDialog({
  clientId,
  companyName,
  whatsappNumber,
  kind = 'client',
}: {
  clientId: string;
  companyName: string;
  /** E.164 digits without the leading `+`. */
  whatsappNumber: string;
  /** Demo tenants use the same record and the same editor. */
  kind?: 'client' | 'demo tenant';
}) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(companyName);
  const [number, setNumber] = React.useState(whatsappNumber);
  const [warning, setWarning] = React.useState<string | null>(null);

  const save = useAction(updateClientProfile);

  // Re-seeds when the server component re-renders after a save, so reopening the
  // dialog never shows the value the operator just replaced.
  React.useEffect(() => {
    setName(companyName);
    setNumber(whatsappNumber);
  }, [companyName, whatsappNumber]);

  function reset() {
    setName(companyName);
    setNumber(whatsappNumber);
    setWarning(null);
    save.reset();
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setWarning(null);

    const result = await save.run(clientId, {
      companyName: name,
      whatsappNumber: number,
    });
    if (!result.ok) return;

    // A collision note keeps the dialog open — closing it would flash a message
    // the operator has no chance to read.
    if (result.data.warning) {
      setWarning(result.data.warning);
      return;
    }

    setOpen(false);
  }

  const dirty = name.trim() !== companyName || number.trim() !== whatsappNumber;
  const numberChanged = number.trim() !== whatsappNumber;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="h-4 w-4" />
          Edit details
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {kind} details</DialogTitle>
          <DialogDescription>
            The name and number recorded at onboarding. Delivery time, plan, vertical
            and spend cap are edited under Operations; the phone printed on the poster
            is on the brand canvas.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-company">Company name</Label>
            <Input
              id="edit-company"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Skyline Realty"
              required
              maxLength={160}
              autoComplete="organization"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-whatsapp">WhatsApp number</Label>
            <Input
              id="edit-whatsapp"
              value={number}
              onChange={(event) => setNumber(event.target.value)}
              placeholder="919876543210"
              inputMode="tel"
              required
              className="font-mono"
            />
            <p className="text-[10px] leading-snug text-muted-foreground">
              International format without “+”. A bare 10-digit number is treated as
              +91.
            </p>
            {numberChanged && (
              <p className="flex items-start gap-1.5 text-[11px] leading-snug text-warning-ink">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                Every creative from the next dispatch on goes to this number instead.
                Days already delivered are not resent.
              </p>
            )}
          </div>

          {save.error && (
            <p role="alert" className="text-xs text-danger-ink">
              {save.error}
            </p>
          )}

          {warning && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs leading-snug text-warning-ink"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Saved. {warning}</span>
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              {warning ? 'Close' : 'Cancel'}
            </Button>
            <Button type="submit" disabled={!dirty || save.pending}>
              {save.pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

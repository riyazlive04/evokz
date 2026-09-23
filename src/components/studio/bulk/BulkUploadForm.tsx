'use client';

import React, { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowRight, CalendarDays, Download, FileSpreadsheet, Images, Layers, RefreshCw, Upload } from 'lucide-react';

import { createStudioBatchAction, type CreateBatchActionResult } from '@/app/admin/poster-studio/bulk/actions';
import { FestivalSelect, QualitySelect } from '@/components/studio/CustomizePanel';
import {
  STUDIO_ASPECT_RATIO_KEYS,
  STUDIO_ASPECT_RATIOS,
  type StudioAspectRatio,
  type StudioQuality,
} from '@/lib/poster-studio/limits';
import { cn } from '@/lib/utils';

export interface BulkCampaignOption {
  id: string;
  name: string;
  clientName: string;
  status: string;
  durationDays: number;
}

/**
 * Upload a Day + Prompt sheet and choose where the images go and the settings
 * every row starts with. Creates a draft only — nothing is generated until the
 * batch is started from its own page.
 */
export function BulkUploadForm({
  clients,
  campaigns,
  defaultQuality,
}: {
  clients: Array<{ id: string; companyName: string }>;
  campaigns: BulkCampaignOption[];
  defaultQuality: string;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<'STUDIO' | 'CAMPAIGN'>('STUDIO');
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [aspectRatio, setAspectRatio] = useState<StudioAspectRatio>('9:16');
  const [festival, setFestival] = useState<string | null>(null);
  const [quality, setQuality] = useState<StudioQuality | null>(null);
  const [textFree, setTextFree] = useState(false);
  const [brandIdentity, setBrandIdentity] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Extract<CreateBatchActionResult, { ok: true }> | null>(null);

  const hasClient = target === 'CAMPAIGN' ? Boolean(campaignId) : Boolean(clientId);

  const submit = async () => {
    setError(null);
    if (!file) {
      setError('Choose the Excel (.xlsx) or .csv file to upload.');
      return;
    }
    if (target === 'CAMPAIGN' && !campaignId) {
      setError('Choose the campaign whose days the sheet fills.');
      return;
    }
    const formData = new FormData();
    formData.set('file', file);
    formData.set('name', name);
    formData.set('target', target);
    formData.set('clientId', target === 'STUDIO' ? clientId : '');
    formData.set('campaignId', target === 'CAMPAIGN' ? campaignId : '');
    formData.set('aspectRatio', aspectRatio);
    formData.set('festival', festival ?? '');
    formData.set('quality', quality ?? '');
    formData.set('textFree', textFree ? '1' : '0');
    formData.set('brandIdentity', hasClient && brandIdentity ? '1' : '0');
    setBusy(true);
    try {
      const result = await createStudioBatchAction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.excluded.length === 0 && result.sheetProblems.length === 0) {
        router.push(`/admin/poster-studio/bulk/${result.batchId}`);
        return;
      }
      setCreated(result);
    } catch {
      setError('The upload did not complete. Your session may have expired — reload the page and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const leftOut = created.excluded.length + created.sheetProblems.length;
    return (
      <div className="rounded-xl border border-border bg-card p-5 space-y-4 shadow-sm">
        <p className="text-sm font-semibold text-foreground">
          {created.created} row{created.created === 1 ? '' : 's'} ready · {leftOut} left out
        </p>
        <ul className="max-h-72 overflow-y-auto space-y-1 text-xs text-muted-foreground list-disc pl-5">
          {created.sheetProblems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
          {created.excluded.map((row) => (
            <li key={`${row.sheetRow}-${row.dayLabel}`}>
              Row {row.sheetRow} ({row.dayLabel}): {row.reason}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => router.push(`/admin/poster-studio/bulk/${created.batchId}`)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90"
          >
            Review the {created.created} row{created.created === 1 ? '' : 's'} <ArrowRight className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setCreated(null)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted"
          >
            Upload a corrected sheet instead
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          The draft is saved either way; nothing is generated until you start it.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <FileSpreadsheet className="w-4 h-4 text-brand-to" /> New bulk run
        </h2>
        <a
          href="/api/poster-studio/bulk/template"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-to hover:underline"
        >
          <Download className="w-3.5 h-3.5" /> Download the Excel template
        </a>
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </p>
      )}

      <div className="space-y-1.5">
        <span className="text-xs font-medium text-foreground">Where the images go</span>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Where the images go">
          {(
            [
              { value: 'STUDIO', icon: Images, title: 'Studio images', hint: 'One image per row, kept on the batch page. Day is just a label.' },
              { value: 'CAMPAIGN', icon: CalendarDays, title: 'Campaign days', hint: 'Day N becomes campaign day N’s poster, waiting for review.' },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={target === option.value}
              disabled={busy}
              onClick={() => setTarget(option.value)}
              className={cn(
                'rounded-lg border p-3 text-left transition-all disabled:opacity-60',
                target === option.value ? 'border-primary bg-primary/10' : 'border-border bg-background hover:border-muted-foreground/30',
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <option.icon className="w-3.5 h-3.5 text-brand-to" /> {option.title}
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{option.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label htmlFor="bulk-name" className="text-xs font-medium text-foreground">
            Name (optional)
          </label>
          <input
            id="bulk-name"
            value={name}
            maxLength={120}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. October posters"
            className="w-full bg-background border border-input rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        {target === 'STUDIO' ? (
          <div className="space-y-1.5">
            <label htmlFor="bulk-client" className="text-xs font-medium text-foreground">
              Client (optional)
            </label>
            <select
              id="bulk-client"
              value={clientId}
              disabled={busy}
              onChange={(event) => setClientId(event.target.value)}
              className="w-full bg-background border border-input rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">No client — generic images</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.companyName}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="space-y-1.5">
            <label htmlFor="bulk-campaign" className="text-xs font-medium text-foreground">
              Campaign
            </label>
            <select
              id="bulk-campaign"
              value={campaignId}
              disabled={busy}
              onChange={(event) => setCampaignId(event.target.value)}
              className="w-full bg-background border border-input rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">Choose a campaign…</option>
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.clientName} — {campaign.name} ({campaign.durationDays} days, {campaign.status.toLowerCase()})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5 text-brand-to" /> Aspect ratio for every row
        </span>
        {target === 'CAMPAIGN' ? (
          <p className="text-[11px] text-muted-foreground">Each day uses its own template&rsquo;s shape, so a campaign poster fits its day.</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5" role="radiogroup" aria-label="Aspect ratio">
            {STUDIO_ASPECT_RATIO_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={aspectRatio === key}
                disabled={busy}
                onClick={() => setAspectRatio(key)}
                className={cn(
                  'rounded-lg border px-2 py-1.5 text-left text-[11px] transition-all',
                  aspectRatio === key ? 'border-primary bg-primary/10 font-semibold text-foreground' : 'border-border bg-background text-muted-foreground',
                )}
              >
                {STUDIO_ASPECT_RATIOS[key].label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FestivalSelect id="bulk-festival" value={festival} onChange={setFestival} disabled={busy} />
        <QualitySelect id="bulk-quality" value={quality} defaultQuality={defaultQuality} onChange={setQuality} disabled={busy} />
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
          <input type="checkbox" checked={textFree} disabled={busy} onChange={(event) => setTextFree(event.target.checked)} />
          Text-free artwork (no lettering)
        </label>
        <label className={cn('flex items-center gap-2 text-xs cursor-pointer', hasClient ? 'text-foreground' : 'text-muted-foreground')}>
          <input
            type="checkbox"
            checked={hasClient && brandIdentity}
            disabled={busy || !hasClient}
            onChange={(event) => setBrandIdentity(event.target.checked)}
          />
          Add the client&rsquo;s exact brand identity (logo, tagline, website, phone from Brand Canvas)
        </label>
        <p className="text-[11px] text-muted-foreground">
          The sheet may set Aspect ratio, Festival, Text free and Quality per row; blank cells use these settings.
        </p>
      </div>

      <div className="space-y-1.5">
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          className="hidden"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="w-full border border-dashed border-input bg-background rounded-lg p-4 text-center hover:border-primary/50 disabled:opacity-60"
        >
          <Upload className="w-5 h-5 text-muted-foreground mx-auto mb-1" />
          <span className="block text-xs font-medium text-foreground">{file ? file.name : 'Choose the sheet (.xlsx or .csv)'}</span>
          <span className="block text-[10px] text-muted-foreground">Columns: Day, Prompt — up to 200 rows, 2 MB</span>
        </button>
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={submit}
        className="w-full py-2.5 rounded-xl bg-gradient-brand text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-md disabled:opacity-50"
      >
        {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
        {busy ? 'Reading the sheet…' : 'Upload and review'}
      </button>
      <p className="text-[11px] text-muted-foreground text-center">Nothing is generated or billed until you start the batch.</p>
    </div>
  );
}

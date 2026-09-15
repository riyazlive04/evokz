'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Building2,
  CheckCircle2,
  Copy,
  Download,
  Image as ImageIcon,
  Info,
  Layers,
  RefreshCw,
  Sliders,
  Sparkles,
  Trash2,
  Type,
  Upload,
  Wand2,
  X,
} from 'lucide-react';

import {
  deleteStudioGenerationAction,
  generateStudioPosterAction,
} from '@/app/admin/poster-studio/actions';
import type { StudioHistoryItem } from '@/lib/poster-studio/history';
import {
  MAX_STUDIO_IMAGE_BYTES,
  MAX_STUDIO_IMAGE_MB,
  MAX_STUDIO_PROMPT_LENGTH,
  MIN_STUDIO_PROMPT_LENGTH,
  STUDIO_ASPECT_RATIO_KEYS,
  STUDIO_ASPECT_RATIOS,
  STUDIO_IMAGE_MIME_TYPES,
  studioImageUrl,
  type StudioAspectRatio,
  type StudioMode,
} from '@/lib/poster-studio/limits';
import { cn } from '@/lib/utils';

interface PosterStudioWorkspaceProps {
  clients: Array<{ id: string; companyName: string }>;
  initialHistory: StudioHistoryItem[];
  loadErrors: string[];
  model: string;
  quality: string;
}

/**
 * The input image attached to the next request.
 *
 * Never a data URI. An upload is held as the `File` and sent as a binary form
 * part; a history image is referenced by generation id and read from Drive on
 * the server.
 */
type Attachment =
  | { kind: 'upload'; file: File; label: string }
  | { kind: 'generation-output'; generationId: string; label: string }
  | { kind: 'generation-reference'; generationId: string; label: string };

const MODE_COPY: Record<
  StudioMode,
  {
    tab: string;
    promptLabel: string;
    placeholder: string;
    imageLabel: string;
    imageRequired: boolean;
    imageHint: string;
    uploadCta: string;
    button: string;
    working: string;
    done: string;
    missingImage: string | null;
  }
> = {
  GENERATE: {
    tab: 'Generate',
    promptLabel: 'Poster brief',
    placeholder:
      'e.g. Launch poster for a luxury 3-BHK apartment in South Mumbai. Headline "Live Above It All". Warm sunset light, modern architecture, gold accents.',
    imageLabel: 'Style reference',
    imageRequired: false,
    imageHint:
      'Sent to the image model as a style and layout reference. Its wording, logos and people are not copied.',
    uploadCta: 'Upload reference image',
    button: 'Generate poster',
    working: 'Generating poster…',
    done: 'Poster generated and saved to History.',
    missingImage: null,
  },
  EDIT: {
    tab: 'Edit',
    promptLabel: 'Edit instruction',
    placeholder: 'e.g. Change the background lighting to dusk blue. Keep the headline and layout.',
    imageLabel: 'Image to edit',
    imageRequired: true,
    imageHint: 'Only the change you describe is applied; the rest of the image is kept as it is.',
    uploadCta: 'Upload image to edit',
    button: 'Apply edit',
    working: 'Applying edit…',
    done: 'Edit applied and saved to History.',
    missingImage:
      'Edit needs an image to change. Upload an image, or choose Edit on a poster in History.',
  },
  VARIATION: {
    tab: 'Variation',
    promptLabel: 'Variation direction',
    placeholder:
      'e.g. Same brand and headline, but a warmer evening palette and a different layout.',
    imageLabel: 'Parent image',
    imageRequired: true,
    imageHint:
      'The new design keeps the parent’s brand identity and follows your direction.',
    uploadCta: 'Upload parent image',
    button: 'Generate variation',
    working: 'Generating variation…',
    done: 'Variation generated and saved to History.',
    missingImage:
      'Variation needs a parent image. Upload an image, or choose Variant on a poster in History.',
  },
};

const MODES: StudioMode[] = ['GENERATE', 'EDIT', 'VARIATION'];

const MODE_BADGE: Record<StudioMode, string> = {
  GENERATE: 'Generated',
  EDIT: 'Edit',
  VARIATION: 'Variation',
};

export function PosterStudioWorkspace({
  clients,
  initialHistory,
  loadErrors,
  model,
  quality,
}: PosterStudioWorkspaceProps) {
  const [mode, setMode] = useState<StudioMode>('GENERATE');
  // One draft per mode: a brief is not an edit instruction, and switching tabs
  // should neither send the wrong text nor throw away what was typed.
  const [drafts, setDrafts] = useState<Record<StudioMode, string>>({
    GENERATE: '',
    EDIT: '',
    VARIATION: '',
  });
  const [aspectRatio, setAspectRatio] = useState<StudioAspectRatio>('9:16');
  const [clientId, setClientId] = useState('');
  const [textFree, setTextFree] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);

  const [history, setHistory] = useState<StudioHistoryItem[]>(initialHistory);
  const [currentId, setCurrentId] = useState<string | null>(initialHistory[0]?.id ?? null);
  const [brokenPreviewId, setBrokenPreviewId] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState<{ dataUri: string; fileName: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const copy = MODE_COPY[mode];
  const prompt = drafts[mode];
  const current = history.find((item) => item.id === currentId) ?? null;

  // Object URLs are created and revoked by the same effect, so a StrictMode
  // remount cannot revoke a URL an <img> is still showing.
  useEffect(() => {
    if (attachment?.kind !== 'upload') {
      setUploadPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(attachment.file);
    setUploadPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment]);

  const attachmentPreview = !attachment
    ? null
    : attachment.kind === 'upload'
      ? uploadPreviewUrl
      : studioImageUrl(attachment.generationId, {
          variant: attachment.kind === 'generation-reference' ? 'reference' : 'output',
          width: 160,
        });

  const handleFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so choosing the same file again still fires a change.
    event.target.value = '';
    if (!file) return;

    if (!(STUDIO_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError(`"${file.name}" is not a supported format. Use a PNG, JPEG or WebP image.`);
      return;
    }
    if (file.size > MAX_STUDIO_IMAGE_BYTES) {
      setError(
        `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_STUDIO_IMAGE_MB} MB.`,
      );
      return;
    }

    setError(null);
    setAttachment({ kind: 'upload', file, label: file.name });
  };

  const handleGenerate = async () => {
    setError(null);
    setSuccess(null);
    setUnsaved(null);

    const trimmed = prompt.trim();
    if (trimmed.length < MIN_STUDIO_PROMPT_LENGTH) {
      setError(`Enter a ${copy.promptLabel.toLowerCase()} of at least ${MIN_STUDIO_PROMPT_LENGTH} characters.`);
      return;
    }
    if (copy.missingImage && !attachment) {
      setError(copy.missingImage);
      return;
    }

    const formData = new FormData();
    formData.set('mode', mode);
    formData.set('prompt', trimmed);
    formData.set('aspectRatio', aspectRatio);
    formData.set('clientId', clientId);
    formData.set('textFree', textFree ? '1' : '0');
    if (!attachment) {
      formData.set('sourceKind', 'none');
    } else if (attachment.kind === 'upload') {
      formData.set('sourceKind', 'upload');
      formData.set('image', attachment.file);
    } else {
      formData.set('sourceKind', attachment.kind);
      formData.set('sourceGenerationId', attachment.generationId);
    }

    const submitted = attachment;
    setLoading(true);

    try {
      const result = await generateStudioPosterAction(formData);

      if (!result.ok) {
        setError(result.error);
        if (result.unsaved) setUnsaved(result.unsaved);
        return;
      }

      const generation = result.generation;
      setHistory((previous) => [generation, ...previous.filter((item) => item.id !== generation.id)]);
      setCurrentId(generation.id);
      setBrokenPreviewId(null);

      // The upload is in Drive now. Point at the stored copy so the next request
      // reuses it instead of uploading the same file again.
      if (submitted?.kind === 'upload' && generation.hasReference) {
        setAttachment({
          kind: 'generation-reference',
          generationId: generation.id,
          label: submitted.label,
        });
      }

      setSuccess(copy.done);
    } catch {
      // A thrown action means the request itself failed — most often an expired
      // session (the middleware answers 401) or a dropped connection.
      setError(
        'The request did not complete. Your session may have expired or the connection dropped — reload the page and try again.',
      );
    } finally {
      setLoading(false);
    }
  };

  const attachHistoryImage = (item: StudioHistoryItem, nextMode: 'EDIT' | 'VARIATION') => {
    setMode(nextMode);
    setAttachment({
      kind: 'generation-output',
      generationId: item.id,
      label: `History · ${describeItem(item)}`,
    });
    setError(null);
    setSuccess(null);
  };

  const handleDelete = async (item: StudioHistoryItem) => {
    if (
      !window.confirm(
        'Delete this poster from History? Its image file is moved to the Google Drive bin unless another history item still uses it.',
      )
    ) {
      return;
    }

    const result = await deleteStudioGenerationAction(item.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    const remaining = history.filter((entry) => entry.id !== item.id);
    setHistory(remaining);
    if (currentId === item.id) setCurrentId(remaining[0]?.id ?? null);
    if (
      attachment &&
      attachment.kind !== 'upload' &&
      attachment.generationId === item.id
    ) {
      setAttachment(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {loadErrors.map((message) => (
        <Banner key={message} tone="error" icon={AlertCircle}>
          {message}
        </Banner>
      ))}

      {error && (
        <Banner tone="error" icon={AlertCircle} onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      {unsaved && (
        <Banner tone="warning" icon={AlertTriangle} onDismiss={() => setUnsaved(null)}>
          <span className="flex flex-wrap items-center gap-3">
            This image was not saved anywhere.
            <a
              href={unsaved.dataUri}
              download={unsaved.fileName}
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90"
            >
              <Download className="w-3.5 h-3.5" /> Download unsaved image
            </a>
          </span>
        </Banner>
      )}

      {success && (
        <Banner tone="success" icon={CheckCircle2} onDismiss={() => setSuccess(null)}>
          {success}
        </Banner>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN: Controls */}
        <div className="lg:col-span-4 xl:col-span-4 rounded-xl border border-border bg-card text-card-foreground p-5 space-y-5 shadow-sm">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                <Wand2 className="w-4 h-4" />
              </div>
              <h2 className="text-sm font-semibold tracking-tight text-foreground">Studio Controls</h2>
            </div>
            <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded bg-muted text-muted-foreground border border-border">
              {copy.tab}
            </span>
          </div>

          {/* Mode */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5 text-brand-to" /> Mode
            </label>
            <div className="grid grid-cols-3 gap-1 bg-muted/60 p-1 rounded-lg border border-border text-xs">
              {MODES.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={loading}
                  onClick={() => setMode(option)}
                  className={cn(
                    'py-1.5 rounded-md font-medium transition-all disabled:opacity-60',
                    mode === option
                      ? 'bg-card text-foreground shadow-sm font-semibold'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {MODE_COPY[option].tab}
                </button>
              ))}
            </div>
          </div>

          {/* Input image */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5 text-brand-to" /> {copy.imageLabel}
              </label>
              <span
                className={cn(
                  'text-[10px] font-medium',
                  copy.imageRequired && !attachment ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {copy.imageRequired ? 'Required' : 'Optional'}
              </span>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept={STUDIO_IMAGE_MIME_TYPES.join(',')}
              onChange={handleFileSelected}
              className="hidden"
            />

            {attachment ? (
              <div className="relative border border-border bg-muted/40 rounded-lg p-2 flex items-center gap-3">
                {attachmentPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a local object URL or a session-gated Drive proxy; next/image can serve neither
                  <img
                    src={attachmentPreview}
                    alt="Attached input"
                    className="w-12 h-16 object-cover rounded border border-border shadow-sm"
                  />
                ) : (
                  <div className="w-12 h-16 rounded border border-border bg-muted" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{attachment.label}</p>
                  <p className="text-[10px] text-muted-foreground leading-snug">{copy.imageHint}</p>
                </div>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => setAttachment(null)}
                  aria-label="Remove attached image"
                  className="p-1 text-muted-foreground hover:text-destructive rounded-md transition-colors disabled:opacity-50"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={loading}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  'w-full border border-dashed bg-background rounded-lg p-4 text-center transition-colors disabled:opacity-60',
                  copy.imageRequired
                    ? 'border-destructive/40 hover:border-destructive/70'
                    : 'border-input hover:border-primary/50',
                )}
              >
                <Upload className="w-5 h-5 text-muted-foreground mx-auto mb-1" />
                <p className="text-xs font-medium text-foreground">{copy.uploadCta}</p>
                <p className="text-[10px] text-muted-foreground">
                  PNG, JPEG or WebP, up to {MAX_STUDIO_IMAGE_MB} MB
                  {copy.imageRequired ? ' — or pick a poster in History' : ''}
                </p>
              </button>
            )}
          </div>

          {/* Prompt */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="studio-prompt"
                className="text-xs font-medium text-foreground flex items-center gap-1.5"
              >
                <Sparkles className="w-3.5 h-3.5 text-brand-to" /> {copy.promptLabel}
              </label>
              <span className="text-[10px] text-muted-foreground">Required</span>
            </div>
            <textarea
              id="studio-prompt"
              value={prompt}
              disabled={loading}
              maxLength={MAX_STUDIO_PROMPT_LENGTH}
              onChange={(event) => {
                const value = event.target.value;
                setDrafts((previous) => ({ ...previous, [mode]: value }));
              }}
              placeholder={copy.placeholder}
              rows={4}
              className="w-full bg-background border border-input rounded-lg p-3 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring resize-none leading-relaxed disabled:opacity-60"
            />
          </div>

          {/* Client brand context */}
          {mode !== 'EDIT' ? (
            <div className="space-y-1.5">
              <label
                htmlFor="studio-client"
                className="text-xs font-medium text-foreground flex items-center gap-1.5"
              >
                <Building2 className="w-3.5 h-3.5 text-brand-to" /> Client brand context (optional)
              </label>
              <select
                id="studio-client"
                value={clientId}
                disabled={loading}
                onChange={(event) => setClientId(event.target.value)}
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
              >
                <option value="">No client — generic studio mode</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.companyName}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-muted-foreground leading-snug">
                Adds the client&apos;s name, industry, tagline, stored brand colours, typography and
                layout rules to the prompt — only what is saved on the client.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-[10px] text-muted-foreground flex items-start gap-2">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <p className="leading-snug">
                Edits send only your instruction with the image, so the existing design is kept.
                {clientId ? ' The selected client is still recorded against the result.' : ''}
              </p>
            </div>
          )}

          {/* Format */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-brand-to" /> Output format
            </label>
            <div className="grid grid-cols-3 gap-2">
              {STUDIO_ASPECT_RATIO_KEYS.map((key) => {
                const option = STUDIO_ASPECT_RATIOS[key];
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={loading}
                    onClick={() => setAspectRatio(key)}
                    className={cn(
                      'p-2.5 rounded-lg border text-left transition-all disabled:opacity-60',
                      aspectRatio === key
                        ? 'border-primary bg-primary/10 text-foreground font-medium shadow-sm'
                        : 'border-border bg-background text-muted-foreground hover:border-muted-foreground/30',
                    )}
                  >
                    <p className="text-xs font-semibold text-foreground">{option.label}</p>
                    <p className="text-[10px] text-muted-foreground">{option.size.replace('x', ' × ')}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Text-free artwork */}
          <label className="flex items-start justify-between gap-3 border-t border-border pt-4 cursor-pointer">
            <span>
              <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <Type className="w-3.5 h-3.5 text-brand-to" /> Text-free artwork
              </span>
              <span className="block text-[10px] text-muted-foreground leading-snug mt-0.5">
                Asks the model for no lettering and clear space for a headline and logo. The studio
                does not add text or logos — place them afterwards in your design tool.
              </span>
            </span>
            <input
              type="checkbox"
              checked={textFree}
              disabled={loading}
              onChange={(event) => setTextFree(event.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-input text-primary focus:ring-ring"
            />
          </label>

          <button
            type="button"
            disabled={loading}
            onClick={handleGenerate}
            className="w-full py-3 px-4 rounded-xl bg-gradient-brand hover:opacity-95 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-md transition-all disabled:opacity-50"
          >
            {loading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin text-white" />
                <span>{copy.working}</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 text-amber-200" />
                <span>{copy.button}</span>
              </>
            )}
          </button>

          <p className="text-[10px] text-muted-foreground text-center">
            {model} · quality {quality} · saved to Google Drive
          </p>
        </div>

        {/* CENTER COLUMN: Preview */}
        <div className="lg:col-span-8 xl:col-span-5 rounded-xl border border-border bg-card text-card-foreground p-6 min-h-[550px] flex flex-col items-center justify-center relative shadow-sm">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-4 text-center p-8">
              <div className="relative">
                <div className="w-16 h-16 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
                <Sparkles className="w-6 h-6 text-brand-to absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{copy.working}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  This can take a minute or more, depending on format and quality.
                </p>
              </div>
            </div>
          ) : current ? (
            <div className="flex flex-col items-center gap-4 max-w-full w-full">
              <div className="relative group max-h-[calc(100vh-16rem)] rounded-xl overflow-hidden border border-border shadow-xl bg-black/90">
                {brokenPreviewId === current.id ? (
                  <div className="flex h-72 w-64 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-white/80">
                    <AlertCircle className="w-6 h-6" />
                    Could not load this image from Google Drive.
                  </div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- session-gated Drive proxy; next/image cannot forward the admin cookie
                  <img
                    key={current.id}
                    src={studioImageUrl(current.id, { width: 1152 })}
                    alt={`Poster: ${current.prompt}`}
                    onError={() => setBrokenPreviewId(current.id)}
                    className="max-h-[calc(100vh-16rem)] w-auto object-contain rounded-xl"
                  />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex items-end justify-between p-4">
                  <span className="text-xs text-white bg-black/60 backdrop-blur px-2.5 py-1 rounded-md border border-white/20 font-medium">
                    {current.aspectRatio} · {current.width && current.height ? `${current.width} × ${current.height}` : current.size}
                  </span>
                  <a
                    href={studioImageUrl(current.id, { download: true })}
                    download
                    className="py-1.5 px-3 bg-primary text-primary-foreground rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-md hover:opacity-90 transition-opacity"
                  >
                    <Download className="w-3.5 h-3.5" /> Download
                  </a>
                </div>
              </div>

              <GenerationDetails
                item={current}
                parentInHistory={
                  current.parentGenerationId
                    ? history.some((item) => item.id === current.parentGenerationId)
                    : false
                }
                onSelectParent={() => current.parentGenerationId && setCurrentId(current.parentGenerationId)}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 text-center p-8 max-w-sm">
              <div className="w-14 h-14 rounded-2xl bg-muted border border-border flex items-center justify-center text-muted-foreground">
                <ImageIcon className="w-7 h-7" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">No posters yet</h3>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  {mode === 'GENERATE'
                    ? 'Write a brief and generate your first poster.'
                    : `${copy.tab} works on an existing image — upload one to start.`}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: History */}
        <div className="lg:col-span-12 xl:col-span-3 rounded-xl border border-border bg-card text-card-foreground p-4 space-y-4 shadow-sm">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <h3 className="text-xs font-semibold tracking-tight text-foreground flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-brand-to" /> History ({history.length})
            </h3>
          </div>

          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">No posters saved yet.</p>
          ) : (
            <div className="grid grid-cols-2 xl:grid-cols-1 gap-3 max-h-[600px] overflow-y-auto pr-1">
              {history.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    'group relative rounded-xl border p-2.5 transition-all',
                    currentId === item.id
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'border-border bg-background hover:border-muted-foreground/30',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setCurrentId(item.id)}
                    className="flex w-full items-start gap-2.5 text-left"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- session-gated Drive proxy */}
                    <img
                      src={studioImageUrl(item.id, { width: 160 })}
                      alt=""
                      loading="lazy"
                      className="w-14 h-20 object-cover rounded-lg border border-border shrink-0 bg-muted"
                    />
                    <span className="flex-1 min-w-0 space-y-1">
                      <span className="block text-xs font-medium text-foreground line-clamp-2 leading-snug">
                        {item.prompt}
                      </span>
                      <span className="flex flex-wrap gap-1">
                        <span className="inline-block text-[10px] text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded font-medium">
                          {MODE_BADGE[item.mode]}
                        </span>
                        <span className="inline-block text-[10px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded font-medium">
                          {item.aspectRatio}
                        </span>
                      </span>
                    </span>
                  </button>

                  <div className="mt-2.5 pt-2 border-t border-border flex items-center justify-between text-[11px] gap-1">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => attachHistoryImage(item, 'EDIT')}
                      className="text-muted-foreground hover:text-primary flex items-center gap-1 font-medium disabled:opacity-50"
                    >
                      <Wand2 className="w-3 h-3" /> Edit
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => attachHistoryImage(item, 'VARIATION')}
                      className="text-muted-foreground hover:text-brand-to flex items-center gap-1 font-medium disabled:opacity-50"
                    >
                      <Copy className="w-3 h-3" /> Variant
                    </button>
                    <a
                      href={studioImageUrl(item.id, { download: true })}
                      download
                      aria-label="Download poster"
                      className="text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 p-0.5"
                    >
                      <Download className="w-3 h-3" />
                    </a>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => handleDelete(item)}
                      aria-label="Delete poster"
                      className="text-muted-foreground hover:text-destructive p-0.5 disabled:opacity-50"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GenerationDetails({
  item,
  parentInHistory,
  onSelectParent,
}: {
  item: StudioHistoryItem;
  parentInHistory: boolean;
  onSelectParent: () => void;
}) {
  return (
    <div className="w-full bg-muted/40 border border-border rounded-xl p-3.5 text-xs space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground text-[11px]">
        <span className="font-semibold uppercase tracking-wider">
          {MODE_BADGE[item.mode]}
          {item.clientName ? ` · ${item.clientName}` : ''}
        </span>
        {/* Formatted in the browser's zone; the server renders its own. */}
        <span suppressHydrationWarning>{new Date(item.createdAt).toLocaleString()}</span>
      </div>

      <div className="flex gap-3">
        {item.hasReference && (
          <div className="shrink-0 space-y-1">
            {/* eslint-disable-next-line @next/next/no-img-element -- session-gated Drive proxy */}
            <img
              src={studioImageUrl(item.id, { variant: 'reference', width: 160 })}
              alt="Input image"
              loading="lazy"
              className="w-12 h-16 object-cover rounded border border-border bg-muted"
            />
            <p className="text-[9px] text-muted-foreground text-center">Input</p>
          </div>
        )}
        <div className="min-w-0 space-y-1">
          <p className="text-foreground font-medium leading-relaxed">{item.prompt}</p>
          <p className="text-[10px] text-muted-foreground">
            {item.model} · quality {item.quality} · {item.size}
            {item.textFree ? ' · text-free' : ''}
          </p>
          {item.parentGenerationId &&
            (parentInHistory ? (
              <button
                type="button"
                onClick={onSelectParent}
                className="text-[10px] text-brand-to hover:underline font-medium"
              >
                {item.mode === 'EDIT' ? 'Edited from' : 'Variation of'} an earlier poster — view it
              </button>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                {item.mode === 'EDIT' ? 'Edited from' : 'Variation of'} an earlier poster
              </p>
            ))}
        </div>
      </div>

      <details>
        <summary className="text-[11px] text-brand-to cursor-pointer hover:underline font-medium">
          Prompt sent to the model
        </summary>
        <p className="text-[11px] text-muted-foreground mt-1.5 p-2 bg-background rounded-md border border-border font-mono whitespace-pre-wrap">
          {item.sentPrompt}
        </p>
      </details>
    </div>
  );
}

function Banner({
  tone,
  icon: Icon,
  children,
  onDismiss,
}: {
  tone: 'error' | 'warning' | 'success';
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      role={tone === 'success' ? 'status' : 'alert'}
      className={cn(
        'rounded-xl border px-4 py-3 flex items-start justify-between gap-3 text-sm shadow-sm animate-in fade-in',
        tone === 'error' && 'border-destructive/40 bg-destructive/15 text-destructive',
        tone === 'warning' && 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        tone === 'success' && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className="w-5 h-5 shrink-0" />
        <div>{children}</div>
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function describeItem(item: StudioHistoryItem): string {
  const text = item.prompt.length > 32 ? `${item.prompt.slice(0, 32)}…` : item.prompt;
  return `${MODE_BADGE[item.mode]} “${text}”`;
}

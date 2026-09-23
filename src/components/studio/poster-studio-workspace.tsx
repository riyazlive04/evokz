'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Building2,
  Combine,
  Check,
  CheckCircle2,
  Copy,
  Minus,
  Shapes,
  Download,
  ExternalLink,
  Image as ImageIcon,
  ImageOff,
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
  loadStudioBrandCanvasAction,
} from '@/app/admin/poster-studio/actions';
import { CampaignDayStudioBanner } from '@/components/campaign/CampaignDayStudioBanner';
import type { CampaignDayStudioContext } from '@/lib/campaign/poster-generation-service';
import type { StudioBrandCanvasSummary } from '@/lib/poster-studio/brand-context';
import { findStudioFestival } from '@/lib/poster-studio/festivals';
import type { StudioHistoryItem } from '@/lib/poster-studio/history';
import {
  MAX_STUDIO_IMAGE_BYTES,
  MAX_STUDIO_IMAGE_MB,
  MAX_STUDIO_PROMPT_LENGTH,
  MIN_STUDIO_PROMPT_LENGTH,
  STUDIO_ASPECT_RATIO_KEYS,
  STUDIO_ASPECT_RATIOS,
  STUDIO_IMAGE_MIME_TYPES,
  studioClientLogoUrl,
  studioImageUrl,
  type StudioAspectRatio,
  type StudioFooterBackground,
  type StudioLogoBackground,
  type StudioMode,
  type StudioOverlayElement,
  type StudioQuality,
} from '@/lib/poster-studio/limits';
import { cn } from '@/lib/utils';

import { BrandCanvasPanel, defaultOverlayElements } from './BrandCanvasPanel';
import {
  CustomizePanel,
  FestivalSelect,
  QualitySelect,
  settingsFromImage,
  type CustomizeSettings,
} from './CustomizePanel';

interface PosterStudioWorkspaceProps {
  clients: Array<{ id: string; companyName: string }>;
  initialHistory: StudioHistoryItem[];
  loadErrors: string[];
  model: string;
  quality: string;
  /** Set when the studio was opened from a campaign day (`?campaignDay=`). */
  campaignDay?: CampaignDayStudioContext | null;
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
  | { kind: 'generation-reference'; generationId: string; label: string }
  | { kind: 'generation-element-reference'; generationId: string; label: string };

const MODE_COPY: Record<
  StudioMode,
  {
    tab: string;
    /** One line under the mode switch: what this mode does. */
    summary: string;
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
    summary: 'A new poster from your brief. Optionally guided by a reference poster.',
    promptLabel: 'Poster brief',
    placeholder:
      'e.g. Launch poster for a luxury 3-BHK apartment in South Mumbai. Headline "Live Above It All". Warm sunset light, modern architecture, gold accents.',
    imageLabel: 'Reference poster',
    imageRequired: false,
    imageHint:
      'Visual inspiration only: its style guides the design. Its wording, logos and brand identity are not copied.',
    uploadCta: 'Upload reference poster',
    button: 'Generate poster',
    working: 'Generating poster…',
    done: 'Poster generated and saved to History.',
    missingImage: null,
  },
  EDIT: {
    tab: 'Edit',
    summary: 'Change part of an existing poster. What you do not mention stays as it is.',
    promptLabel: 'Edit instruction',
    placeholder:
      'e.g. Replace the main photo with a modern family dental consultation. Keep the headline and layout.',
    imageLabel: 'Image to edit',
    imageRequired: true,
    imageHint: 'The change you describe is applied fully; the rest of the image is kept as it is.',
    uploadCta: 'Upload image to edit',
    button: 'Apply edit',
    working: 'Applying edit…',
    done: 'Edit applied and saved to History.',
    missingImage:
      'Edit needs an image to change. Upload an image, or choose Edit on a poster in History.',
  },
  VARIATION: {
    tab: 'Variation',
    summary: 'A fresh creative direction for the same campaign: new concept, imagery and layout.',
    promptLabel: 'Variation direction',
    placeholder:
      'e.g. A bright illustrated take — the family outdoors in the sun, headline set large at the top.',
    imageLabel: 'Parent image',
    imageRequired: true,
    imageHint:
      'Used for the campaign’s message and mood. The concept, imagery and layout are redesigned.',
    uploadCta: 'Upload parent image',
    button: 'Generate variation',
    working: 'Generating variation…',
    done: 'Variation generated and saved to History.',
    missingImage:
      'Variation needs a parent image. Upload an image, or choose Vary on a poster in History.',
  },
  MIX: {
    tab: 'Mix',
    summary: 'Take specific elements from a reference image and add them to a base poster.',
    promptLabel: 'What to take, and where it goes',
    placeholder:
      'e.g. Take the gold diya border from the reference and run it around the edge of the base poster. Keep everything else.',
    imageLabel: 'Base image',
    imageRequired: true,
    imageHint: 'The poster to change. Everything your instruction does not mention is kept.',
    uploadCta: 'Upload base image',
    button: 'Mix elements',
    working: 'Mixing elements…',
    done: 'Elements mixed and saved to History.',
    missingImage: 'Mix needs a base image. Upload the poster to change, or choose Mix on a poster in History.',
  },
};

const MODES: StudioMode[] = ['GENERATE', 'EDIT', 'VARIATION', 'MIX'];

/** Mix's second slot. Only the named elements are taken from this image. */
const ELEMENT_SLOT_COPY = {
  label: 'Element reference',
  hint: 'Only the elements your instruction names are taken from this image — never its layout, wording or branding.',
  uploadCta: 'Upload reference image',
  missing: 'Mix needs a reference image to take elements from. Upload it, or choose "Mix ref" on a poster in History.',
};

const MODE_BADGE: Record<StudioHistoryItem['mode'], string> = {
  GENERATE: 'Generated',
  EDIT: 'Edit',
  VARIATION: 'Variation',
  CLONE: 'Template clone',
  MIX: 'Mix',
};

export function PosterStudioWorkspace({
  clients,
  initialHistory,
  loadErrors,
  model,
  quality,
  campaignDay = null,
}: PosterStudioWorkspaceProps) {
  // Opened from a campaign day: start on an Edit of the day's active poster (its
  // RAW artwork, as any History edit), or on a Generate from the day's content
  // when it has no poster yet. Everything after that is the studio as usual.
  const campaignSource = campaignDay?.activeGenerationId ?? null;
  const [mode, setMode] = useState<StudioMode>(campaignDay ? (campaignSource ? 'EDIT' : 'GENERATE') : 'GENERATE');
  // One draft per mode: a brief is not an edit instruction, and switching tabs
  // should neither send the wrong text nor throw away what was typed.
  const [drafts, setDrafts] = useState<Record<StudioMode, string>>({
    GENERATE: campaignDay && !campaignSource ? campaignDay.brief : '',
    EDIT: '',
    VARIATION: '',
    MIX: '',
  });
  const [aspectRatio, setAspectRatio] = useState<StudioAspectRatio>(campaignDay?.aspectRatio ?? '9:16');
  const [clientId, setClientId] = useState(campaignDay?.clientId ?? '');
  const [textFree, setTextFree] = useState(false);
  const [festival, setFestival] = useState<string | null>(null);
  /** Null: the server's configured quality. */
  const [qualityChoice, setQualityChoice] = useState<StudioQuality | null>(null);
  const [attachment, setAttachment] = useState<Attachment | null>(
    campaignDay && campaignSource
      ? {
          kind: 'generation-output',
          generationId: campaignSource,
          label: `Campaign day ${campaignDay.dayNumber} · v${campaignDay.activeVersionNumber}`,
        }
      : null,
  );
  /** Mix only: the image whose named elements are carried onto `attachment`. */
  const [elementAttachment, setElementAttachment] = useState<Attachment | null>(null);

  const [history, setHistory] = useState<StudioHistoryItem[]>(initialHistory);
  const [currentId, setCurrentId] = useState<string | null>(campaignSource ?? initialHistory[0]?.id ?? null);
  const [brokenPreviewId, setBrokenPreviewId] = useState<string | null>(null);
  /** Bumped by "Try again" on a preview that failed to load, to refetch it. */
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState<{ dataUri: string; fileName: string } | null>(null);
  /** Set when the server refused "Remove background" for this logo; offers "Keep original". */
  const [logoBackgroundRefused, setLogoBackgroundRefused] = useState(false);

  // The selected client's existing Brand Canvas — loaded, never re-entered here.
  const [brandCanvas, setBrandCanvas] = useState<StudioBrandCanvasSummary | null>(null);
  const [brandLoading, setBrandLoading] = useState(false);
  const [brandError, setBrandError] = useState<string | null>(null);
  const [overlayElements, setOverlayElements] = useState<StudioOverlayElement[]>([]);
  const [logoBackground, setLogoBackground] = useState<StudioLogoBackground>('ORIGINAL');
  const [footerBackground, setFooterBackground] = useState<StudioFooterBackground>('AUTO');

  const previewRef = useRef<HTMLDivElement>(null);

  const copy = MODE_COPY[mode];
  const prompt = drafts[mode];
  const current = history.find((item) => item.id === currentId) ?? null;

  // A generation keeps running on the server if the page is left, and still
  // lands in History — but the operator would lose sight of it. Warn, and count
  // the seconds so a slow request visibly is still working.
  useEffect(() => {
    if (!loading) return;
    const started = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => setElapsedSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('beforeunload', warn);
    };
  }, [loading]);

  /** On a single-column layout the preview sits below the controls; bring it into view. */
  const revealPreview = () => {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) {
      previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const selectItem = (id: string) => {
    setCurrentId(id);
    setBrokenPreviewId(null);
    revealPreview();
  };

  useEffect(() => {
    setLogoBackgroundRefused(false);
    if (!clientId) {
      setBrandCanvas(null);
      setBrandError(null);
      setOverlayElements([]);
      setBrandLoading(false);
      return;
    }

    let cancelled = false;
    setBrandLoading(true);
    setBrandError(null);
    setBrandCanvas(null);
    setOverlayElements([]);

    loadStudioBrandCanvasAction(clientId)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setBrandError(result.error);
          return;
        }
        const summary = result.summary;
        setBrandCanvas(summary);
        setOverlayElements(defaultOverlayElements(summary));
        setLogoBackground(summary.logo.removal.possible ? summary.logo.defaultBackground : 'ORIGINAL');
      })
      .catch(() => {
        if (!cancelled) setBrandError('The Brand Canvas could not be loaded. Reload the page and try again.');
      })
      .finally(() => {
        if (!cancelled) setBrandLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [clientId]);

  /** Checks a chosen file against the studio's limits: the problem, or null when it can be sent. */
  const checkFile = (file: File): string | null => {
    if (!(STUDIO_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
      return `"${file.name}" is not a supported format. Use a PNG, JPEG or WebP image.`;
    }
    if (file.size > MAX_STUDIO_IMAGE_BYTES) {
      return `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_STUDIO_IMAGE_MB} MB.`;
    }
    return null;
  };

  const attachFile = (file: File, target: 'base' | 'element') => {
    const problem = checkFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    const next: Attachment = { kind: 'upload', file, label: file.name };
    if (target === 'element') setElementAttachment(next);
    else setAttachment(next);
  };

  const handleGenerate = async () => {
    setError(null);
    setSuccess(null);
    setWarning(null);
    setUnsaved(null);
    setLogoBackgroundRefused(false);

    const trimmed = prompt.trim();
    if (trimmed.length < MIN_STUDIO_PROMPT_LENGTH) {
      setError(`Enter a ${copy.promptLabel.toLowerCase()} of at least ${MIN_STUDIO_PROMPT_LENGTH} characters.`);
      return;
    }
    if (copy.missingImage && !attachment) {
      setError(copy.missingImage);
      return;
    }
    if (mode === 'MIX' && !elementAttachment) {
      setError(ELEMENT_SLOT_COPY.missing);
      return;
    }
    if (clientId && brandLoading) {
      setError('The Brand Canvas is still loading. Try again in a moment.');
      return;
    }
    // A client was chosen for their branding; without the Brand Canvas the poster
    // would silently come out unbranded.
    if (clientId && brandError) {
      setError(
        'The Brand Canvas for this client could not be loaded, so the poster cannot be branded. Choose the client again, or switch to generic studio mode.',
      );
      return;
    }
    const drawsLogo = overlayElements.includes('logo');
    if (drawsLogo && logoBackground === 'REMOVED' && brandCanvas && !brandCanvas.logo.removal.possible) {
      setError(brandCanvas.logo.removal.message ?? 'The background cannot be removed from this logo.');
      setLogoBackgroundRefused(true);
      return;
    }

    const formData = new FormData();
    formData.set('mode', mode);
    formData.set('prompt', trimmed);
    formData.set('aspectRatio', aspectRatio);
    formData.set('clientId', clientId);
    formData.set('textFree', textFree ? '1' : '0');
    formData.set('overlayElements', clientId ? overlayElements.join(',') : '');
    formData.set('logoBackground', logoBackground);
    formData.set('footerBackground', footerBackground);
    formData.set('festival', festival ?? '');
    formData.set('quality', qualityChoice ?? '');
    if (!attachment) {
      formData.set('sourceKind', 'none');
    } else if (attachment.kind === 'upload') {
      formData.set('sourceKind', 'upload');
      formData.set('image', attachment.file);
    } else {
      formData.set('sourceKind', attachment.kind);
      formData.set('sourceGenerationId', attachment.generationId);
    }
    const element = mode === 'MIX' ? elementAttachment : null;
    if (!element) {
      formData.set('elementSourceKind', 'none');
    } else if (element.kind === 'upload') {
      formData.set('elementSourceKind', 'upload');
      formData.set('elementImage', element.file);
    } else {
      formData.set('elementSourceKind', element.kind);
      formData.set('elementSourceGenerationId', element.generationId);
    }

    const submitted = attachment;
    await submitRequest(formData, copy.done, (generation) => {
      // The upload is in Drive now. Point at the stored copy so the next request
      // reuses it instead of uploading the same file again.
      if (submitted?.kind === 'upload' && generation.hasReference) {
        setAttachment({
          kind: 'generation-reference',
          generationId: generation.id,
          label: submitted.label,
        });
      }
      if (element?.kind === 'upload' && generation.hasElementReference) {
        setElementAttachment({
          kind: 'generation-element-reference',
          generationId: generation.id,
          label: element.label,
        });
      }
    });
  };

  /** Sends one studio request and shows its outcome; shared by the form and Customize. */
  const submitRequest = async (
    formData: FormData,
    doneMessage: string,
    onSaved?: (generation: StudioHistoryItem) => void,
  ) => {
    setLoading(true);

    try {
      const result = await generateStudioPosterAction(formData);

      if (!result.ok) {
        setError(result.error);
        if (result.kind === 'logo-background') setLogoBackgroundRefused(true);
        if (result.unsaved) setUnsaved(result.unsaved);
        return;
      }
      if (result.warning) setWarning(result.warning);

      const generation = result.generation;
      setHistory((previous) => [generation, ...previous.filter((item) => item.id !== generation.id)]);
      selectItem(generation.id);
      onSaved?.(generation);
      setSuccess(doneMessage);
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

  /**
   * Customize: the same request that made `item` — its mode, prompt and stored
   * input images — with the new settings. The result is a new History item,
   * recorded as a child of `item`; `item` itself is never changed.
   */
  const handleCustomize = async (item: StudioHistoryItem, settings: CustomizeSettings) => {
    setError(null);
    setSuccess(null);
    setWarning(null);
    setUnsaved(null);
    setLogoBackgroundRefused(false);
    if (item.mode === 'CLONE') return;

    const formData = new FormData();
    formData.set('mode', item.mode);
    formData.set('prompt', settings.prompt);
    formData.set('aspectRatio', settings.aspectRatio);
    formData.set('clientId', settings.clientId ?? '');
    formData.set('textFree', settings.textFree ? '1' : '0');
    formData.set('overlayElements', settings.clientId ? settings.overlayElements.join(',') : '');
    formData.set('logoBackground', settings.logoBackground);
    formData.set('footerBackground', settings.footerBackground);
    formData.set('festival', settings.festival ?? '');
    formData.set('quality', settings.quality ?? '');
    formData.set('sourceKind', item.hasReference ? 'generation-reference' : 'none');
    formData.set('sourceGenerationId', item.hasReference ? item.id : '');
    formData.set('elementSourceKind', item.hasElementReference ? 'generation-element-reference' : 'none');
    formData.set('elementSourceGenerationId', item.hasElementReference ? item.id : '');
    formData.set('redoOfGenerationId', item.id);

    await submitRequest(formData, 'Customized poster saved to History. The original is kept.');
  };

  /** Mix's second slot, from History: the poster's raw artwork is the element source. */
  const attachHistoryElement = (item: StudioHistoryItem) => {
    setMode('MIX');
    setElementAttachment({ kind: 'generation-output', generationId: item.id, label: `History · ${describeItem(item)}` });
    setError(null);
    setSuccess(null);
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const attachHistoryImage = (item: StudioHistoryItem, nextMode: 'EDIT' | 'VARIATION' | 'MIX') => {
    setMode(nextMode);
    // Keep the poster's Brand Canvas: an edit or variation of a client's poster
    // is composited with that client's identity again.
    if (item.clientId && clients.some((client) => client.id === item.clientId)) {
      setClientId(item.clientId);
    }
    setAttachment({
      kind: 'generation-output',
      generationId: item.id,
      label: `History · ${describeItem(item)}`,
    });
    setError(null);
    setSuccess(null);
    // The controls are above the preview on a narrow screen; the attachment
    // and prompt are what the operator needs next.
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleDelete = async (item: StudioHistoryItem) => {
    const hasChildren = history.some((entry) => entry.parentGenerationId === item.id);
    if (
      !window.confirm(
        hasChildren
          ? 'Delete this poster from History? Edits and variations made from it are kept. Its image files go to the Google Drive bin unless another history item still uses them.'
          : 'Delete this poster from History? Its image files go to the Google Drive bin unless another history item still uses them.',
      )
    ) {
      return;
    }

    setDeletingId(item.id);
    try {
      const result = await deleteStudioGenerationAction(item.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }

      // Children survive with their parent link cleared, as in the database.
      const remaining = history
        .filter((entry) => entry.id !== item.id)
        .map((entry) => (entry.parentGenerationId === item.id ? { ...entry, parentGenerationId: null } : entry));
      setHistory(remaining);
      if (currentId === item.id) setCurrentId(remaining[0]?.id ?? null);
      if (attachment && attachment.kind !== 'upload' && attachment.generationId === item.id) {
        setAttachment(null);
      }
      if (elementAttachment && elementAttachment.kind !== 'upload' && elementAttachment.generationId === item.id) {
        setElementAttachment(null);
      }
    } catch {
      setError('The poster could not be deleted. Your session may have expired — reload the page and try again.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {loadErrors.map((message) => (
        <Banner key={message} tone="error" icon={AlertCircle}>
          {message}
        </Banner>
      ))}

      {campaignDay && <CampaignDayStudioBanner context={campaignDay} current={current} busy={loading} />}

      {error && (
        <Banner tone="error" icon={AlertCircle} onDismiss={() => setError(null)}>
          <span className="flex flex-wrap items-center gap-3">
            {error}
            {logoBackgroundRefused && (
              <button
                type="button"
                onClick={() => {
                  setLogoBackground('ORIGINAL');
                  setLogoBackgroundRefused(false);
                  setError(null);
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-background px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-muted"
              >
                Use &ldquo;Keep original&rdquo; for this poster
              </button>
            )}
          </span>
        </Banner>
      )}

      {warning && (
        <Banner tone="warning" icon={AlertTriangle} onDismiss={() => setWarning(null)}>
          {warning}
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
            <div className="grid grid-cols-4 gap-1 bg-muted/60 p-1 rounded-lg border border-border text-xs">
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
            <p className="text-[11px] text-muted-foreground leading-snug">{copy.summary}</p>
          </div>

          {/* Input image(s) */}
          <AttachmentSlot
            label={copy.imageLabel}
            required={copy.imageRequired}
            hint={copy.imageHint}
            uploadCta={copy.uploadCta}
            attachment={attachment}
            disabled={loading}
            onFile={(file) => attachFile(file, 'base')}
            onRemove={() => setAttachment(null)}
          />
          {mode === 'MIX' && (
            <AttachmentSlot
              label={ELEMENT_SLOT_COPY.label}
              required
              hint={ELEMENT_SLOT_COPY.hint}
              uploadCta={ELEMENT_SLOT_COPY.uploadCta}
              attachment={elementAttachment}
              disabled={loading}
              onFile={(file) => attachFile(file, 'element')}
              onRemove={() => setElementAttachment(null)}
            />
          )}

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

          {/* Client and Brand Canvas */}
          <div className="space-y-1.5">
            <label
              htmlFor="studio-client"
              className="text-xs font-medium text-foreground flex items-center gap-1.5"
            >
              <Building2 className="w-3.5 h-3.5 text-brand-to" /> Client (optional)
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
            {mode === 'EDIT' && (
              <p className="text-[10px] text-muted-foreground leading-snug flex items-start gap-1.5">
                <Info className="w-3 h-3 shrink-0 mt-0.5" />
                Edits send only your instruction with the raw artwork, so the design is kept. The
                Brand Canvas identity is composited onto the result.
              </p>
            )}
          </div>

          {clientId && (
            <BrandCanvasPanel
              clientId={clientId}
              summary={brandCanvas}
              loading={brandLoading}
              error={brandError}
              elements={overlayElements}
              onElementsChange={setOverlayElements}
              logoBackground={logoBackground}
              onLogoBackgroundChange={(value) => {
                setLogoBackground(value);
                setLogoBackgroundRefused(false);
              }}
              footerBackground={footerBackground}
              onFooterBackgroundChange={setFooterBackground}
              disabled={loading}
            />
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

          {/* Festival and quality */}
          <div className="grid grid-cols-2 gap-3">
            <FestivalSelect id="studio-festival" value={festival} onChange={setFestival} disabled={loading} />
            <QualitySelect
              id="studio-quality"
              value={qualityChoice}
              defaultQuality={quality}
              onChange={setQualityChoice}
              disabled={loading}
            />
          </div>

          {/* Text-free artwork */}
          <label className="flex items-start justify-between gap-3 border-t border-border pt-4 cursor-pointer">
            <span>
              <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <Type className="w-3.5 h-3.5 text-brand-to" /> Text-free artwork
              </span>
              <span className="block text-[10px] text-muted-foreground leading-snug mt-0.5">
                Asks the model for artwork with no lettering, leaving clear space for a headline. Any
                exact brand identity selected above is still added in the footer.
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
            {model} · quality {qualityChoice ?? quality} · saved to Google Drive
          </p>
        </div>

        {/* CENTER COLUMN: Preview */}
        <div
          ref={previewRef}
          className="lg:col-span-8 xl:col-span-5 rounded-xl border border-border bg-card text-card-foreground p-4 sm:p-6 min-h-[420px] sm:min-h-[550px] flex flex-col items-center justify-center relative shadow-sm scroll-mt-4"
        >
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-4 text-center p-8" aria-live="polite">
              <div className="relative">
                <div className="w-16 h-16 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
                <Sparkles className="w-6 h-6 text-brand-to absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{copy.working}</p>
                <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                  {formatElapsed(elapsedSeconds)} elapsed · usually 30–90 seconds
                </p>
                <p className="text-[11px] text-muted-foreground mt-2 max-w-xs">
                  If you leave this page, the poster still finishes and appears in History when you
                  come back.
                </p>
              </div>
            </div>
          ) : current ? (
            <div className="flex flex-col items-center gap-4 max-w-full w-full">
              <div className="relative max-w-full rounded-xl overflow-hidden border border-border shadow-xl bg-muted">
                {brokenPreviewId === current.id ? (
                  <div className="flex h-72 w-64 max-w-full flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted-foreground">
                    <ImageOff className="w-6 h-6" />
                    <span>This image could not be loaded. It may have been removed from Google Drive.</span>
                    <button
                      type="button"
                      onClick={() => {
                        setBrokenPreviewId(null);
                        setPreviewAttempt((attempt) => attempt + 1);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 font-semibold text-foreground hover:bg-muted"
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> Try again
                    </button>
                  </div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- session-gated Drive proxy; next/image cannot forward the admin cookie
                  <img
                    key={`${current.id}-${previewAttempt}`}
                    src={`${studioImageUrl(current.id, { width: 1152 })}${previewAttempt > 0 ? `&retry=${previewAttempt}` : ''}`}
                    alt={`Poster: ${current.prompt}`}
                    onError={() => setBrokenPreviewId(current.id)}
                    className="block max-h-[70vh] lg:max-h-[calc(100vh-16rem)] max-w-full w-auto object-contain"
                  />
                )}
                <span className="absolute left-2 top-2 text-[10px] text-white bg-black/60 backdrop-blur px-2 py-0.5 rounded-md border border-white/20 font-medium">
                  {current.aspectRatio} · {current.width && current.height ? `${current.width} × ${current.height}` : current.size}
                </span>
              </div>

              <div className="flex w-full flex-wrap items-center justify-center gap-2">
                <a
                  href={studioImageUrl(current.id, { download: true })}
                  download
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-sm hover:opacity-90"
                >
                  <Download className="w-3.5 h-3.5" /> Download
                </a>
                <a
                  href={studioImageUrl(current.id, { width: 2048 })}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> Full size
                </a>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => attachHistoryImage(current, 'EDIT')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
                >
                  <Wand2 className="w-3.5 h-3.5" /> Edit
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => attachHistoryImage(current, 'VARIATION')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
                >
                  <Copy className="w-3.5 h-3.5" /> Variation
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => attachHistoryImage(current, 'MIX')}
                  title="Use this poster as the base of a Mix"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
                >
                  <Combine className="w-3.5 h-3.5" /> Mix
                </button>
                <button
                  type="button"
                  disabled={loading || deletingId === current.id}
                  onClick={() => handleDelete(current)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-destructive hover:border-destructive/40 disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" /> {deletingId === current.id ? 'Deleting…' : 'Delete'}
                </button>
              </div>

              {current.mode === 'CLONE' ? null : current.mode !== 'GENERATE' && !current.hasReference ? (
                <p className="w-full text-[11px] text-muted-foreground">
                  This poster&rsquo;s input image is not stored, so it cannot be customized. Upload the image again
                  instead.
                </p>
              ) : (
                <CustomizePanel
                  id={`customize-${current.id}`}
                  initial={settingsFromImage(current)}
                  clients={clients}
                  defaultQuality={quality}
                  disabled={loading}
                  note={`Makes a new ${MODE_BADGE[current.mode].toLowerCase()} image from the same ${
                    current.hasReference ? 'inputs' : 'prompt'
                  } — one more generation. This poster stays in History.`}
                  onApply={(settings) => void handleCustomize(current, settings)}
                />
              )}

              <GenerationDetails
                item={current}
                parentInHistory={
                  current.parentGenerationId
                    ? history.some((item) => item.id === current.parentGenerationId)
                    : false
                }
                onSelectParent={() => current.parentGenerationId && selectItem(current.parentGenerationId)}
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
                    ? 'Write a brief, pick a client for exact branding, and generate your first poster.'
                    : `${copy.tab} works on an existing image — upload one, or generate a poster first and pick it from History.`}
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
            <p className="text-xs text-muted-foreground text-center py-6">
              No posters saved yet. Everything you generate is kept here.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-3 max-h-[600px] overflow-y-auto pr-1">
              {history.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    'group relative rounded-xl border p-2.5 transition-all min-w-0',
                    currentId === item.id
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'border-border bg-background hover:border-muted-foreground/30',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => selectItem(item.id)}
                    aria-label={`Preview ${describeItem(item)}`}
                    className="flex w-full items-start gap-2.5 text-left"
                  >
                    <HistoryThumbnail id={item.id} />
                    <span className="flex-1 min-w-0 space-y-1">
                      {/* No `block`: it would override line-clamp's -webkit-box display. */}
                      <span className="text-xs font-medium text-foreground line-clamp-2 leading-snug [overflow-wrap:anywhere]">
                        {item.prompt}
                      </span>
                      <span className="flex flex-wrap gap-1">
                        <span className="inline-block text-[10px] text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded font-medium">
                          {MODE_BADGE[item.mode]}
                        </span>
                        <span className="inline-block text-[10px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded font-medium">
                          {item.aspectRatio}
                        </span>
                        {item.clientName && (
                          <span
                            className="inline-block max-w-full truncate text-[10px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded font-medium"
                            title={item.clientName}
                          >
                            {item.clientName}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>

                  <div className="mt-2 pt-1.5 border-t border-border grid grid-cols-6 text-[11px]">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => attachHistoryImage(item, 'EDIT')}
                      className="flex items-center justify-center gap-1 rounded-md py-1.5 text-muted-foreground hover:text-primary hover:bg-muted font-medium disabled:opacity-50"
                    >
                      <Wand2 className="w-3.5 h-3.5" /> Edit
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => attachHistoryImage(item, 'VARIATION')}
                      className="flex items-center justify-center gap-1 rounded-md py-1.5 text-muted-foreground hover:text-brand-to hover:bg-muted font-medium disabled:opacity-50"
                    >
                      <Copy className="w-3.5 h-3.5" /> Vary
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => attachHistoryImage(item, 'MIX')}
                      aria-label="Use as the base of a Mix"
                      title="Mix: use as the base"
                      className="flex items-center justify-center rounded-md py-1.5 text-muted-foreground hover:text-primary hover:bg-muted disabled:opacity-50"
                    >
                      <Combine className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => attachHistoryElement(item)}
                      aria-label="Use as the element reference of a Mix"
                      title="Mix ref: take elements from this poster"
                      className="flex items-center justify-center rounded-md py-1.5 text-muted-foreground hover:text-primary hover:bg-muted disabled:opacity-50"
                    >
                      <Shapes className="w-3.5 h-3.5" />
                    </button>
                    <a
                      href={studioImageUrl(item.id, { download: true })}
                      download
                      aria-label="Download poster"
                      title="Download"
                      className="flex items-center justify-center rounded-md py-1.5 text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-muted"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </a>
                    <button
                      type="button"
                      disabled={loading || deletingId === item.id}
                      onClick={() => handleDelete(item)}
                      aria-label="Delete poster"
                      title="Delete"
                      className="flex items-center justify-center rounded-md py-1.5 text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50"
                    >
                      {deletingId === item.id ? (
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
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
    <div className="w-full min-w-0 bg-muted/40 border border-border rounded-xl p-3.5 text-xs space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground text-[11px]">
        <span className="font-semibold uppercase tracking-wider min-w-0 break-words">
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
              onError={(event) => {
                event.currentTarget.style.visibility = 'hidden';
              }}
              className="w-12 h-16 object-cover rounded border border-border bg-muted"
            />
            <p className="text-[9px] text-muted-foreground text-center">{item.mode === 'MIX' ? 'Base' : 'Input'}</p>
          </div>
        )}
        {item.hasElementReference && (
          <div className="shrink-0 space-y-1">
            {/* eslint-disable-next-line @next/next/no-img-element -- session-gated Drive proxy */}
            <img
              src={studioImageUrl(item.id, { variant: 'element-reference', width: 160 })}
              alt="Element reference"
              loading="lazy"
              onError={(event) => {
                event.currentTarget.style.visibility = 'hidden';
              }}
              className="w-12 h-16 object-cover rounded border border-border bg-muted"
            />
            <p className="text-[9px] text-muted-foreground text-center">Elements</p>
          </div>
        )}
        <div className="min-w-0 space-y-1">
          <p className="text-foreground font-medium leading-relaxed break-words whitespace-pre-line max-h-40 overflow-y-auto">
            {item.prompt}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {item.model} · quality {item.quality} · {item.size}
            {item.textFree ? ' · text-free' : ''}
            {item.festival ? ` · ${findStudioFestival(item.festival)?.label ?? item.festival}` : ''}
          </p>
          {item.hasFinal ? (
            <p className="text-[10px] text-muted-foreground">
              Brand identity: {item.overlayElements.map(describeElement).join(', ')}
              {item.logoBackground
                ? ` · logo ${item.logoBackground === 'REMOVED' ? 'background removed' : 'original background'}`
                : ''}
              {item.footerTone ? ` · ${describeFooter(item.footerBackground, item.footerTone)}` : ''}
              {' · '}
              <a
                href={studioImageUrl(item.id, { variant: 'raw', download: true })}
                download
                className="text-brand-to hover:underline font-medium"
              >
                download raw artwork
              </a>
            </p>
          ) : item.clientId ? (
            <p className="text-[10px] text-muted-foreground">No brand identity overlay — raw artwork only.</p>
          ) : null}
          {item.parentGenerationId &&
            (parentInHistory ? (
              <button
                type="button"
                onClick={onSelectParent}
                className="text-[10px] text-brand-to hover:underline font-medium"
              >
                {lineageLabel(item.mode)} an earlier poster — view it
              </button>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                {lineageLabel(item.mode)} an earlier poster
              </p>
            ))}
        </div>
      </div>

      <details>
        <summary className="text-[11px] text-brand-to cursor-pointer hover:underline font-medium">
          Prompt sent to the model
        </summary>
        <p className="text-[11px] text-muted-foreground mt-1.5 p-2 bg-background rounded-md border border-border font-mono whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
          {item.sentPrompt}
        </p>
      </details>
    </div>
  );
}

/** How a child poster relates to the parent it was made from. */
function lineageLabel(mode: StudioHistoryItem['mode']): string {
  switch (mode) {
    case 'EDIT':
      return 'Edited from';
    case 'MIX':
      return 'Mixed onto';
    case 'GENERATE':
      return 'Regenerated from';
    default:
      return 'Variation of';
  }
}

/**
 * One input image slot: the attached image with a remove button, or an upload
 * button. The object URL for an upload is created and revoked by the same
 * effect, so a StrictMode remount cannot revoke a URL an <img> is still showing.
 */
function AttachmentSlot({
  label,
  required,
  hint,
  uploadCta,
  attachment,
  disabled,
  onFile,
  onRemove,
}: {
  label: string;
  required: boolean;
  hint: string;
  uploadCta: string;
  attachment: Attachment | null;
  disabled: boolean;
  onFile: (file: File) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (attachment?.kind !== 'upload') {
      setUploadPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(attachment.file);
    setUploadPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment]);

  const preview = !attachment
    ? null
    : attachment.kind === 'upload'
      ? uploadPreviewUrl
      : studioImageUrl(attachment.generationId, {
          // A history poster is sent to the model as its RAW artwork, so that is
          // what the attachment shows.
          variant:
            attachment.kind === 'generation-reference'
              ? 'reference'
              : attachment.kind === 'generation-element-reference'
                ? 'element-reference'
                : 'raw',
          width: 160,
        });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <ImageIcon className="w-3.5 h-3.5 text-brand-to" /> {label}
        </label>
        <span
          className={cn(
            'text-[10px] font-medium',
            required && !attachment ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {required ? 'Required' : 'Optional'}
        </span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={STUDIO_IMAGE_MIME_TYPES.join(',')}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file again still fires a change.
          event.target.value = '';
          if (file) onFile(file);
        }}
        className="hidden"
      />

      {attachment ? (
        <div className="relative border border-border bg-muted/40 rounded-lg p-2 flex items-center gap-3">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local object URL or a session-gated Drive proxy; next/image can serve neither
            <img
              src={preview}
              alt={`Attached: ${label}`}
              onError={(event) => {
                event.currentTarget.style.visibility = 'hidden';
              }}
              className="w-12 h-16 object-cover rounded border border-border shadow-sm bg-muted shrink-0"
            />
          ) : (
            <div className="w-12 h-16 rounded border border-border bg-muted shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground truncate">{attachment.label}</p>
            <p className="text-[10px] text-muted-foreground leading-snug">{hint}</p>
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={onRemove}
            aria-label={`Remove ${label.toLowerCase()}`}
            className="p-1 text-muted-foreground hover:text-destructive rounded-md transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className={cn(
            'w-full border border-dashed bg-background rounded-lg p-4 text-center transition-colors disabled:opacity-60',
            required ? 'border-destructive/40 hover:border-destructive/70' : 'border-input hover:border-primary/50',
          )}
        >
          <Upload className="w-5 h-5 text-muted-foreground mx-auto mb-1" />
          <p className="text-xs font-medium text-foreground">{uploadCta}</p>
          <p className="text-[10px] text-muted-foreground">
            PNG, JPEG or WebP, up to {MAX_STUDIO_IMAGE_MB} MB
            {required ? ' — or pick a poster in History' : ''}
          </p>
        </button>
      )}
    </div>
  );
}

/** A History thumbnail that degrades to a placeholder when the image cannot be loaded. */
function HistoryThumbnail({ id }: { id: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span
        className="w-14 h-20 rounded-lg border border-border shrink-0 bg-muted flex items-center justify-center text-muted-foreground"
        title="Image unavailable"
      >
        <ImageOff className="w-4 h-4" />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- session-gated Drive proxy
    <img
      src={studioImageUrl(id, { width: 160 })}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className="w-14 h-20 object-cover rounded-lg border border-border shrink-0 bg-muted"
    />
  );
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${String(rest).padStart(2, '0')}s` : `${rest}s`;
}

function describeFooter(choice: StudioHistoryItem['footerBackground'], tone: StudioHistoryItem['footerTone']): string {
  const toneLabel = tone === 'LIGHT' ? 'light' : 'dark';
  return choice === 'AUTO' ? `footer auto (${toneLabel})` : `footer ${toneLabel}`;
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

const ELEMENT_LABELS: Record<string, string> = {
  logo: 'logo',
  name: 'company name',
  tagline: 'tagline',
  website: 'website',
  phone: 'phone',
};

function describeElement(element: string): string {
  return ELEMENT_LABELS[element] ?? element;
}

function describeItem(item: StudioHistoryItem): string {
  const text = item.prompt.length > 32 ? `${item.prompt.slice(0, 32)}…` : item.prompt;
  return `${MODE_BADGE[item.mode]} “${text}”`;
}

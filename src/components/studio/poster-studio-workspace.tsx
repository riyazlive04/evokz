'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  Image as ImageIcon,
  Upload,
  RefreshCw,
  Download,
  Trash2,
  Sliders,
  Layers,
  Wand2,
  AlertCircle,
  CheckCircle2,
  X,
  Building2,
  Copy,
  Info,
} from 'lucide-react';

import {
  generateStudioPosterAction,
  fetchStudioHistoryAction,
  deleteStudioGenerationAction,
  fetchStudioClientsAction,
  type StudioHistoryItem,
} from '@/app/admin/poster-studio/actions';
import type { PosterStudioAspectRatio } from '@/lib/ai/openai-images';
import type { ReferenceAnalysisResult } from '@/lib/ai/studio-prompts';
import { cn } from '@/lib/utils';

interface PosterStudioWorkspaceProps {
  initialClients?: Array<{ id: string; companyName: string }>;
  initialHistory?: StudioHistoryItem[];
}

export function PosterStudioWorkspace({
  initialClients = [],
  initialHistory = [],
}: PosterStudioWorkspaceProps) {
  // Form State
  const [prompt, setPrompt] = useState('');
  const [editInstruction, setEditInstruction] = useState('');
  const [mode, setMode] = useState<'generate' | 'edit' | 'variation'>('generate');
  const [aspectRatio, setAspectRatio] = useState<PosterStudioAspectRatio>('1024x1792');
  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [referenceDataUri, setReferenceDataUri] = useState<string | null>(null);
  const [referenceFileName, setReferenceFileName] = useState<string>('');
  const [hybridOverlay, setHybridOverlay] = useState<boolean>(false);

  // Data & Execution State
  const [history, setHistory] = useState<StudioHistoryItem[]>(initialHistory);
  const [clients, setClients] = useState<Array<{ id: string; companyName: string }>>(initialClients);
  const [currentGeneration, setCurrentGeneration] = useState<StudioHistoryItem | null>(initialHistory[0] ?? null);
  const [currentAnalysis, setCurrentAnalysis] = useState<ReferenceAnalysisResult | null>(null);

  // Status & Feedback
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (clients.length === 0) {
      fetchStudioClientsAction().then((res) => {
        if (res.ok && res.data) setClients(res.data);
      });
    }
    if (history.length === 0) {
      fetchStudioHistoryAction().then((res) => {
        if (res.ok && res.data) {
          setHistory(res.data);
          if (res.data[0]) setCurrentGeneration(res.data[0]);
        }
      });
    }
  }, [clients.length, history.length]);

  // Handle reference file upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('Please upload a valid image file (PNG, JPEG, WebP).');
      return;
    }

    // Production-safe 10 MB limit (consistent with backend validation)
    if (file.size > 10 * 1024 * 1024) {
      setError('Image file is too large. Maximum size is 10 MB.');
      return;
    }

    setReferenceFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      setReferenceDataUri(event.target?.result as string);
      setError(null);
      setSuccess('Reference image attached.');
    };
    reader.readAsDataURL(file);
  };

  const removeReferenceImage = () => {
    setReferenceDataUri(null);
    setReferenceFileName('');
    setCurrentAnalysis(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Run Generation
  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError('Please enter a poster concept description.');
      return;
    }

    if (mode === 'edit' && !editInstruction.trim()) {
      setError('Please enter natural-language edit instructions for what to modify.');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    const isEdit = mode === 'edit';
    const isVar = mode === 'variation';

    setStatusMessage(
      isEdit
        ? 'Applying edit instructions to poster...'
        : isVar
          ? 'Generating variation from parent poster...'
          : referenceDataUri
            ? 'Analyzing reference layout & generating AI poster...'
            : 'Connecting to OpenAI API to render poster graphics...',
    );

    try {
      const res = await generateStudioPosterAction({
        prompt: prompt.trim(),
        mode,
        aspectRatio,
        referenceDataUri: referenceDataUri ?? undefined,
        editInstruction: mode === 'edit' ? editInstruction.trim() : undefined,
        parentGenerationId: currentGeneration?.id,
        clientId: selectedClientId || undefined,
        hybridOverlay,
      });

      if (!res.ok) {
        setError(res.error);
      } else {
        const newGen = res.data.generation;
        setCurrentGeneration(newGen);
        setHistory((prev) => [newGen, ...prev.filter((h) => h.id !== newGen.id)]);
        if (res.data.analysis) {
          setCurrentAnalysis(res.data.analysis);
        }
        setSuccess(
          isEdit
            ? 'Poster edit applied successfully!'
            : isVar
              ? 'Poster variation generated successfully!'
              : 'Poster generated successfully!',
        );
      }
    } catch (err: any) {
      setError(err?.message || 'An unexpected error occurred during poster generation.');
    } finally {
      setLoading(false);
      setStatusMessage('');
    }
  };

  // Handle Download
  const handleDownload = (imageUrl: string, filename = 'ai-poster.png') => {
    const link = document.createElement('a');
    link.href = imageUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Set Item as Edit Reference
  const handleUseAsEditReference = (item: StudioHistoryItem) => {
    setReferenceDataUri(item.imageUrl);
    setReferenceFileName(`Generation ${item.id.slice(0, 6)}`);
    setMode('edit');
    setSuccess('Poster attached for editing! Enter your edit instructions below.');
  };

  // Set Item as Variation Parent
  const handleUseAsVariationParent = (item: StudioHistoryItem) => {
    setReferenceDataUri(item.imageUrl);
    setReferenceFileName(`Generation ${item.id.slice(0, 6)}`);
    setMode('variation');
    setSuccess('Poster set as variation parent!');
  };

  // Delete item
  const handleDeleteItem = async (id: string) => {
    await deleteStudioGenerationAction(id);
    setHistory((prev) => prev.filter((item) => item.id !== id));
    if (currentGeneration?.id === id) {
      const remaining = history.filter((h) => h.id !== id);
      setCurrentGeneration(remaining[0] ?? null);
    }
  };

  // Button text by mode
  const getButtonText = () => {
    if (mode === 'edit') return 'Apply Edit Instruction';
    if (mode === 'variation') return 'Generate Variation';
    return 'Generate AI Poster';
  };

  // Empty state title and subtitle by mode
  const getEmptyStateContent = () => {
    if (mode === 'edit') {
      return {
        title: 'No Image Selected for Edit',
        subtitle: 'Select or upload a poster, then describe the changes you want.',
      };
    }
    if (mode === 'variation') {
      return {
        title: 'No Poster Selected for Variation',
        subtitle: 'Select a generated poster and create a new variation.',
      };
    }
    return {
      title: 'No Poster Generated Yet',
      subtitle: 'Describe your poster and generate your first AI design.',
    };
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Banner Notifications */}
      {error && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/15 text-destructive px-4 py-3 flex items-center justify-between text-sm shadow-sm animate-in fade-in">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="opacity-70 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {success && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-4 py-3 flex items-center justify-between text-sm shadow-sm animate-in fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 shrink-0" />
            <span>{success}</span>
          </div>
          <button onClick={() => setSuccess(null)} className="opacity-70 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Main Responsive Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN: Control & Inputs */}
        <div className="lg:col-span-4 xl:col-span-4 rounded-xl border border-border bg-card text-card-foreground p-5 space-y-5 shadow-sm">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                <Wand2 className="w-4 h-4" />
              </div>
              <h2 className="text-sm font-semibold tracking-tight text-foreground">Studio Controls</h2>
            </div>
            <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded bg-muted text-muted-foreground border border-border">
              {mode}
            </span>
          </div>

          {/* Mode Selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5 text-brand-to" /> Generation Mode
            </label>
            <div className="grid grid-cols-3 gap-1 bg-muted/60 p-1 rounded-lg border border-border text-xs">
              <button
                type="button"
                onClick={() => setMode('generate')}
                className={cn(
                  'py-1.5 rounded-md font-medium transition-all',
                  mode === 'generate'
                    ? 'bg-card text-foreground shadow-sm font-semibold'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Generate
              </button>
              <button
                type="button"
                onClick={() => setMode('edit')}
                className={cn(
                  'py-1.5 rounded-md font-medium transition-all',
                  mode === 'edit'
                    ? 'bg-card text-foreground shadow-sm font-semibold'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setMode('variation')}
                className={cn(
                  'py-1.5 rounded-md font-medium transition-all',
                  mode === 'variation'
                    ? 'bg-card text-foreground shadow-sm font-semibold'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Variation
              </button>
            </div>
          </div>

          {/* Client Brand Context Selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-brand-to" /> Client Brand Context (Optional)
            </label>
            <select
              value={selectedClientId}
              onChange={(e) => setSelectedClientId(e.target.value)}
              className="w-full bg-background border border-input rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">-- Generic Studio Mode --</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.companyName}
                </option>
              ))}
            </select>
          </div>

          {/* Variation Mode Helpful Guidance Box */}
          {mode === 'variation' && !referenceDataUri && (
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground flex items-start gap-2 animate-in fade-in">
              <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
              <p className="leading-snug">
                Variation mode creates a new design variant based on an existing poster. Select a poster from History or upload a reference image.
              </p>
            </div>
          )}

          {/* Poster Description Input */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-brand-to" /> Poster Concept / Description
              </label>
              <span className="text-[10px] text-muted-foreground">Required</span>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                mode === 'variation'
                  ? 'e.g. Create a variant with warmer evening lighting and a different camera angle'
                  : 'e.g. Luxury 3-BHK apartment launch event in South Mumbai, warm sunset ambient lighting, modern architectural photography, elegant gold accents...'
              }
              rows={4}
              className="w-full bg-background border border-input rounded-lg p-3 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring resize-none leading-relaxed"
            />
          </div>

          {/* Conditional Edit Instruction (ONLY when Mode = Edit) */}
          {mode === 'edit' && (
            <div className="space-y-1.5 animate-in fade-in">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
                  <Wand2 className="w-3.5 h-3.5 text-amber-500" /> Natural-Language Edit Instructions
                </label>
                <span className="text-[10px] text-muted-foreground">Required</span>
              </div>
              <input
                type="text"
                value={editInstruction}
                onChange={(e) => setEditInstruction(e.target.value)}
                placeholder="e.g. Change background lighting to dusk blue and add pool reflections"
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          )}

          {/* Reference Image Uploader */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5 text-brand-to" />
                {mode === 'edit' ? 'Target Image to Edit' : mode === 'variation' ? 'Parent Image for Variation' : 'Reference Poster / Style Guide'}
              </label>
              <span className="text-[10px] text-muted-foreground">
                {mode === 'edit' || mode === 'variation' ? 'Recommended' : 'Optional'}
              </span>
            </div>

            {referenceDataUri ? (
              <div className="relative border border-border bg-muted/40 rounded-lg p-2 flex items-center gap-3">
                <img src={referenceDataUri} alt="Reference" className="w-12 h-16 object-cover rounded border border-border shadow-sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{referenceFileName || 'Attached Poster'}</p>
                  <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                    {mode === 'edit' ? 'Target image attached for editing' : mode === 'variation' ? 'Parent poster attached for variation' : 'Attached for reference guidance'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={removeReferenceImage}
                  className="p-1 text-muted-foreground hover:text-destructive rounded-md transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border border-dashed border-input hover:border-primary/50 bg-background rounded-lg p-4 text-center cursor-pointer transition-colors"
              >
                <Upload className="w-5 h-5 text-muted-foreground mx-auto mb-1" />
                <p className="text-xs font-medium text-foreground">
                  {mode === 'edit' ? 'Upload Target Image to Edit' : mode === 'variation' ? 'Upload Parent Poster' : 'Upload Reference Poster'}
                </p>
                <p className="text-[10px] text-muted-foreground">PNG, JPG or WebP up to 10 MB</p>
                <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
              </div>
            )}
          </div>

          {/* Aspect Ratio Selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-brand-to" /> Aspect Ratio / Output Format
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: '1024x1792', label: '9:16 Story', desc: 'Vertical' },
                { id: '1024x1024', label: '1:1 Square', desc: 'Feed Post' },
                { id: '1792x1024', label: '16:9 Banner', desc: 'Landscape' },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setAspectRatio(item.id as PosterStudioAspectRatio)}
                  className={cn(
                    'p-2.5 rounded-lg border text-left transition-all',
                    aspectRatio === item.id
                      ? 'border-primary bg-primary/10 text-foreground font-medium shadow-sm'
                      : 'border-border bg-background text-muted-foreground hover:border-muted-foreground/30',
                  )}
                >
                  <p className="text-xs font-semibold text-foreground">{item.label}</p>
                  <p className="text-[10px] text-muted-foreground">{item.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Vector Text Overlay Toggle */}
          <div className="flex items-center justify-between border-t border-border pt-4">
            <div>
              <p className="text-xs font-medium text-foreground">Vector Text Overlay Mode</p>
              <p className="text-[10px] text-muted-foreground">Composites clean vector text & logos</p>
            </div>
            <input
              type="checkbox"
              checked={hybridOverlay}
              onChange={(e) => setHybridOverlay(e.target.checked)}
              className="w-4 h-4 rounded border-input text-primary focus:ring-ring"
            />
          </div>

          {/* Context-Aware Primary Action Button */}
          <button
            type="button"
            disabled={loading}
            onClick={handleGenerate}
            className="w-full py-3 px-4 rounded-xl bg-gradient-brand hover:opacity-95 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-md transition-all disabled:opacity-50"
          >
            {loading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin text-white" />
                <span>Processing Request...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 text-amber-200" />
                <span>{getButtonText()}</span>
              </>
            )}
          </button>
        </div>

        {/* CENTER COLUMN: Large Canvas Preview */}
        <div className="lg:col-span-8 xl:col-span-5 rounded-xl border border-border bg-card text-card-foreground p-6 min-h-[550px] flex flex-col items-center justify-center relative shadow-sm">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-4 text-center p-8">
              <div className="relative">
                <div className="w-16 h-16 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
                <Sparkles className="w-6 h-6 text-brand-to absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{statusMessage || 'Rendering poster design...'}</p>
                <p className="text-xs text-muted-foreground mt-1">This typically takes 8-15 seconds via GPT-Image-2</p>
              </div>
            </div>
          ) : currentGeneration ? (
            <div className="flex flex-col items-center gap-4 max-w-full w-full">
              {/* Main Image Container */}
              <div className="relative group max-h-[calc(100vh-16rem)] rounded-xl overflow-hidden border border-border shadow-xl bg-black/90">
                <img
                  src={currentGeneration.imageUrl}
                  alt="AI Poster Preview"
                  className="max-h-[calc(100vh-16rem)] w-auto object-contain rounded-xl"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-between p-4">
                  <span className="text-xs text-white bg-black/60 backdrop-blur px-2.5 py-1 rounded-md border border-white/20 font-medium">
                    {currentGeneration.aspectRatio} • {currentGeneration.mode}
                  </span>
                  <button
                    onClick={() => handleDownload(currentGeneration.imageUrl, `poster-${currentGeneration.id.slice(0, 8)}.png`)}
                    className="py-1.5 px-3 bg-primary text-primary-foreground rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-md hover:opacity-90 transition-opacity"
                  >
                    <Download className="w-3.5 h-3.5" /> Download Asset
                  </button>
                </div>
              </div>

              {/* Poster Info Metadata Card */}
              <div className="w-full bg-muted/40 border border-border rounded-xl p-3.5 text-xs space-y-1.5">
                <div className="flex items-center justify-between text-muted-foreground text-[11px]">
                  <span className="font-semibold uppercase tracking-wider">Concept Prompt</span>
                  <span>{new Date(currentGeneration.createdAt).toLocaleTimeString()}</span>
                </div>
                <p className="text-foreground font-medium leading-relaxed">{currentGeneration.prompt}</p>
                {currentGeneration.revisedPrompt && (
                  <details className="mt-1">
                    <summary className="text-[11px] text-brand-to cursor-pointer hover:underline font-medium">
                      View Revised Prompt
                    </summary>
                    <p className="text-[11px] text-muted-foreground mt-1.5 p-2 bg-background rounded-md border border-border font-mono italic">
                      {currentGeneration.revisedPrompt}
                    </p>
                  </details>
                )}
              </div>
            </div>
          ) : (
            /* Mode-aware empty state */
            <div className="flex flex-col items-center justify-center gap-3 text-center p-8 max-w-sm">
              <div className="w-14 h-14 rounded-2xl bg-muted border border-border flex items-center justify-center text-muted-foreground">
                <ImageIcon className="w-7 h-7" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">{getEmptyStateContent().title}</h3>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  {getEmptyStateContent().subtitle}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: History & Variations */}
        <div className="lg:col-span-12 xl:col-span-3 rounded-xl border border-border bg-card text-card-foreground p-4 space-y-4 shadow-sm">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <h3 className="text-xs font-semibold tracking-tight text-foreground flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-brand-to" /> History & Variations ({history.length})
            </h3>
          </div>

          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">No previous generations recorded.</p>
          ) : (
            <div className="grid grid-cols-2 xl:grid-cols-1 gap-3 max-h-[600px] overflow-y-auto pr-1">
              {history.map((item) => (
                <div
                  key={item.id}
                  onClick={() => setCurrentGeneration(item)}
                  className={cn(
                    'group relative rounded-xl border p-2.5 cursor-pointer transition-all',
                    currentGeneration?.id === item.id
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'border-border bg-background hover:border-muted-foreground/30',
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <img src={item.imageUrl} alt="Thumbnail" className="w-14 h-20 object-cover rounded-lg border border-border shrink-0 shadow-xs" />
                    <div className="flex-1 min-w-0 space-y-1">
                      <p className="text-xs font-medium text-foreground line-clamp-2 leading-snug">{item.prompt}</p>
                      <span className="inline-block text-[10px] text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded font-medium">
                        {item.aspectRatio}
                      </span>
                    </div>
                  </div>

                  <div className="mt-2.5 pt-2 border-t border-border flex items-center justify-between text-[11px] gap-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleUseAsEditReference(item);
                      }}
                      className="text-muted-foreground hover:text-primary flex items-center gap-1 font-medium"
                    >
                      <Wand2 className="w-3 h-3" /> Edit
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleUseAsVariationParent(item);
                      }}
                      className="text-muted-foreground hover:text-brand-to flex items-center gap-1 font-medium"
                    >
                      <Copy className="w-3 h-3" /> Variant
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownload(item.imageUrl, `poster-${item.id.slice(0, 6)}.png`);
                      }}
                      className="text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 p-0.5"
                    >
                      <Download className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteItem(item.id);
                      }}
                      className="text-muted-foreground hover:text-destructive p-0.5"
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

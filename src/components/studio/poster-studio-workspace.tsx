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
  Copy,
  Info,
  Maximize2,
  Building2,
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
    // Load clients if not passed
    if (clients.length === 0) {
      fetchStudioClientsAction().then((res) => {
        if (res.ok && res.data) setClients(res.data);
      });
    }
    // Load history
    if (history.length === 0) {
      fetchStudioHistoryAction().then((res) => {
        if (res.ok && res.data) {
          setHistory(res.data);
          if (res.data[0]) setCurrentGeneration(res.data[0]);
        }
      });
    }
  }, []);

  // Handle reference file upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('Please upload a valid image file (PNG, JPEG, WebP).');
      return;
    }

    if (file.size > 8 * 1024 * 1024) {
      setError('Image file is too large. Maximum size is 8 MB.');
      return;
    }

    setReferenceFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      setReferenceDataUri(event.target?.result as string);
      setError(null);
      setSuccess('Reference image uploaded successfully.');
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
      setError('Please enter a poster prompt describing your desired visual theme.');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);
    setStatusMessage(
      referenceDataUri
        ? 'Analyzing reference image layout and generating poster...'
        : 'Connecting to OpenAI API to render poster graphics...',
    );

    try {
      const res = await generateStudioPosterAction({
        prompt: prompt.trim(),
        mode,
        aspectRatio,
        referenceDataUri: referenceDataUri ?? undefined,
        editInstruction: editInstruction.trim() || undefined,
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
        setSuccess('Poster generated successfully!');
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

  // Reuse as Reference
  const handleUseAsReference = (item: StudioHistoryItem) => {
    setReferenceDataUri(item.imageUrl);
    setReferenceFileName(`Generation ${item.id.slice(0, 8)}`);
    setMode('edit');
    setSuccess('Image set as reference! Enter your edit instructions below.');
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

  return (
    <div className="flex flex-col min-h-[calc(100vh-4rem)] bg-slate-950 text-slate-100 font-sans">
      {/* Top Banner Alert Bar */}
      {error && (
        <div className="bg-rose-950/90 border-b border-rose-800 text-rose-200 px-4 py-3 flex items-center justify-between text-sm animate-in fade-in">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="text-rose-400 hover:text-rose-200">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {success && (
        <div className="bg-emerald-950/90 border-b border-emerald-800 text-emerald-200 px-4 py-3 flex items-center justify-between text-sm animate-in fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            <span>{success}</span>
          </div>
          <button onClick={() => setSuccess(null)} className="text-emerald-400 hover:text-emerald-200">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Main Studio Grid */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-0 overflow-hidden">
        {/* LEFT COLUMN: Controls & Input Panel */}
        <div className="lg:col-span-4 xl:col-span-3 border-r border-slate-800 bg-slate-900/60 p-5 overflow-y-auto flex flex-col gap-6">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400">
                <Wand2 className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-100">AI Poster Studio</h2>
                <p className="text-xs text-slate-400">Design studio-grade marketing posters</p>
              </div>
            </div>
          </div>

          {/* Mode Switcher */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5 text-indigo-400" /> Mode
            </label>
            <div className="grid grid-cols-3 gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => setMode('generate')}
                className={`py-1.5 rounded-md font-medium transition-colors ${
                  mode === 'generate' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Generate
              </button>
              <button
                type="button"
                onClick={() => setMode('edit')}
                className={`py-1.5 rounded-md font-medium transition-colors ${
                  mode === 'edit' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setMode('variation')}
                className={`py-1.5 rounded-md font-medium transition-colors ${
                  mode === 'variation' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Variation
              </button>
            </div>
          </div>

          {/* Client Brand Selector (Optional) */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-indigo-400" /> Client Brand Context (Optional)
            </label>
            <select
              value={selectedClientId}
              onChange={(e) => setSelectedClientId(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="">-- Generic Studio Mode --</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.companyName}
                </option>
              ))}
            </select>
          </div>

          {/* Poster Prompt Input */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-300 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-indigo-400" /> Poster Description / Concept
              </span>
              <span className="text-[10px] text-slate-500">Required</span>
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Luxury 3-BHK luxury apartment launch event in South Mumbai, warm sunset ambient lighting, modern architectural photography, elegant gold accents..."
              rows={4}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 resize-none"
            />
          </div>

          {/* Edit Instruction Input (shown when mode is edit or variation) */}
          {(mode === 'edit' || mode === 'variation') && (
            <div className="space-y-2 animate-in fade-in">
              <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                <Wand2 className="w-3.5 h-3.5 text-amber-400" /> Natural-Language Edit Instructions
              </label>
              <input
                type="text"
                value={editInstruction}
                onChange={(e) => setEditInstruction(e.target.value)}
                placeholder="e.g. Change background lighting to dusk blue and add luxury pool reflections"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-500"
              />
            </div>
          )}

          {/* Optional Reference Poster Upload */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-300 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5 text-indigo-400" /> Reference Poster / Style Guide
              </span>
              <span className="text-[10px] text-slate-500">Optional</span>
            </label>

            {referenceDataUri ? (
              <div className="relative group border border-slate-700 bg-slate-950 rounded-lg p-2 flex items-center gap-3">
                <img src={referenceDataUri} alt="Reference" className="w-12 h-16 object-cover rounded border border-slate-800" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-slate-200 truncate">{referenceFileName || 'Reference Poster'}</p>
                  <p className="text-[10px] text-emerald-400">Attached for layout guidance</p>
                </div>
                <button
                  type="button"
                  onClick={removeReferenceImage}
                  className="p-1 text-slate-400 hover:text-rose-400 rounded-md transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-slate-800 hover:border-slate-700 bg-slate-950/50 rounded-lg p-4 text-center cursor-pointer transition-colors"
              >
                <Upload className="w-6 h-6 text-slate-500 mx-auto mb-1" />
                <p className="text-xs font-medium text-slate-300">Upload Reference Image</p>
                <p className="text-[10px] text-slate-500">PNG, JPG or WebP up to 8MB</p>
                <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
              </div>
            )}
          </div>

          {/* Aspect Ratio Selector */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-indigo-400" /> Aspect Ratio / Format
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
                  className={`p-2.5 rounded-lg border text-left transition-all ${
                    aspectRatio === item.id
                      ? 'border-indigo-500 bg-indigo-950/40 text-white'
                      : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <p className="text-xs font-semibold">{item.label}</p>
                  <p className="text-[10px] opacity-70">{item.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Hybrid Overlay Toggle */}
          <div className="flex items-center justify-between border-t border-slate-800 pt-4">
            <div>
              <p className="text-xs font-medium text-slate-300">Vector Text Overlay Mode</p>
              <p className="text-[10px] text-slate-500">Composites clean vector text & logos</p>
            </div>
            <input
              type="checkbox"
              checked={hybridOverlay}
              onChange={(e) => setHybridOverlay(e.target.checked)}
              className="w-4 h-4 rounded bg-slate-950 border-slate-800 text-indigo-600 focus:ring-indigo-500"
            />
          </div>

          {/* Generate Action Button */}
          <button
            type="button"
            disabled={loading}
            onClick={handleGenerate}
            className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-medium text-sm flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 transition-all disabled:opacity-50"
          >
            {loading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin text-white" />
                <span>Generating Poster...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 text-amber-300" />
                <span>
                  {mode === 'edit' ? 'Apply Edit Instruction' : mode === 'variation' ? 'Generate Variation' : 'Generate AI Poster'}
                </span>
              </>
            )}
          </button>
        </div>

        {/* CENTER COLUMN: Main Poster Preview Canvas */}
        <div className="lg:col-span-8 xl:col-span-6 bg-slate-950 p-6 flex flex-col items-center justify-center relative min-h-[500px]">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-4 text-center p-8">
              <div className="relative">
                <div className="w-16 h-16 rounded-full border-4 border-indigo-600/30 border-t-indigo-500 animate-spin" />
                <Sparkles className="w-6 h-6 text-indigo-400 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse" />
              </div>
              <div>
                <p className="text-sm font-medium text-slate-200">{statusMessage || 'Rendering poster design...'}</p>
                <p className="text-xs text-slate-500 mt-1">This typically takes 8-15 seconds using DALL-E 3</p>
              </div>
            </div>
          ) : currentGeneration ? (
            <div className="flex flex-col items-center gap-4 max-w-full w-full">
              {/* Image Canvas Container */}
              <div className="relative group max-h-[calc(100vh-14rem)] rounded-xl overflow-hidden border border-slate-800 shadow-2xl bg-slate-900/80">
                <img
                  src={currentGeneration.imageUrl}
                  alt="AI Poster"
                  className="max-h-[calc(100vh-14rem)] w-auto object-contain rounded-xl"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-between p-4">
                  <span className="text-xs text-slate-300 bg-slate-900/80 backdrop-blur px-2.5 py-1 rounded-md border border-slate-700">
                    {currentGeneration.aspectRatio} • {currentGeneration.mode}
                  </span>
                  <button
                    onClick={() => handleDownload(currentGeneration.imageUrl, `poster-${currentGeneration.id.slice(0, 8)}.png`)}
                    className="py-1.5 px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 shadow-lg transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" /> Download
                  </button>
                </div>
              </div>

              {/* Prompt Info Card */}
              <div className="w-full max-w-lg bg-slate-900/80 border border-slate-800 rounded-xl p-3 text-xs text-slate-300 space-y-1">
                <div className="flex items-center justify-between text-slate-400 text-[11px]">
                  <span>Prompt Concept</span>
                  <span>{new Date(currentGeneration.createdAt).toLocaleTimeString()}</span>
                </div>
                <p className="text-slate-200 font-medium line-clamp-2">{currentGeneration.prompt}</p>
                {currentGeneration.revisedPrompt && (
                  <details className="mt-1">
                    <summary className="text-[10px] text-indigo-400 cursor-pointer hover:underline">
                      View Revised OpenAI Prompt
                    </summary>
                    <p className="text-[11px] text-slate-400 mt-1 p-2 bg-slate-950 rounded border border-slate-800 italic">
                      {currentGeneration.revisedPrompt}
                    </p>
                  </details>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 text-center p-8 max-w-sm">
              <div className="w-14 h-14 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-600">
                <ImageIcon className="w-7 h-7" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-200">No Poster Generated Yet</h3>
                <p className="text-xs text-slate-500 mt-1">
                  Enter a concept prompt on the left panel to render high-fidelity social media and marketing posters.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: Generation History & Variations Panel */}
        <div className="lg:col-span-12 xl:col-span-3 border-l border-slate-800 bg-slate-900/40 p-4 overflow-y-auto flex flex-col gap-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-indigo-400" /> History & Variations ({history.length})
            </h3>
          </div>

          {history.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-6">No previous generations recorded.</p>
          ) : (
            <div className="grid grid-cols-2 xl:grid-cols-1 gap-3">
              {history.map((item) => (
                <div
                  key={item.id}
                  onClick={() => setCurrentGeneration(item)}
                  className={`group relative rounded-lg border p-2 cursor-pointer transition-all ${
                    currentGeneration?.id === item.id
                      ? 'border-indigo-500 bg-indigo-950/30'
                      : 'border-slate-800 bg-slate-950 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <img src={item.imageUrl} alt="Thumbnail" className="w-14 h-20 object-cover rounded border border-slate-800 shrink-0" />
                    <div className="flex-1 min-w-0 space-y-1">
                      <p className="text-xs font-medium text-slate-200 line-clamp-2">{item.prompt}</p>
                      <span className="inline-block text-[10px] text-indigo-400 bg-indigo-950/60 border border-indigo-800/40 px-1.5 py-0.5 rounded">
                        {item.aspectRatio}
                      </span>
                    </div>
                  </div>

                  <div className="mt-2 pt-2 border-t border-slate-800/60 flex items-center justify-between text-[11px]">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleUseAsReference(item);
                      }}
                      className="text-slate-400 hover:text-indigo-400 flex items-center gap-1"
                    >
                      <Wand2 className="w-3 h-3" /> Edit
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownload(item.imageUrl, `poster-${item.id.slice(0, 6)}.png`);
                      }}
                      className="text-slate-400 hover:text-emerald-400 flex items-center gap-1"
                    >
                      <Download className="w-3 h-3" /> Save
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteItem(item.id);
                      }}
                      className="text-slate-500 hover:text-rose-400"
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

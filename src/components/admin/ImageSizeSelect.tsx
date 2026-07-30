'use client';

import * as React from 'react';

import { AlertTriangle, ImageOff } from 'lucide-react';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DEFAULT_IMAGE_SIZE_ID,
  describeImageSize,
  FAL_MAX_EDGE,
  getImageSizePreset,
  groupedImageSizePresets,
  photoIsUpscaledAt,
  photoUpscaleFactor,
} from '@/lib/image-sizes';

/**
 * The output-size picker, shared by manual onboarding and the client detail
 * page so both surfaces offer the same catalogue in the same order.
 *
 * Renders the two advisories the catalogue carries — off-brand shape (per
 * docs/creative-style-spec.md) and a softened background photo at very large
 * canvases — below the trigger rather than inside the option rows: Radix renders
 * the selected option's text into the trigger, so badges placed there would leak
 * into the closed control.
 *
 * Neither advisory blocks the choice. Both describe a creative trade-off an
 * operator may well have decided to accept.
 */
export function ImageSizeSelect({
  id,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  /** A preset id, or '' for "not chosen — use the fleet default". */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const groups = React.useMemo(groupedImageSizePresets, []);
  const selected = getImageSizePreset(value);
  const softPhoto = selected ? photoIsUpscaledAt(selected) : false;

  return (
    <div className="space-y-1.5">
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Use fleet default (WhatsApp Status)" />
        </SelectTrigger>
        <SelectContent className="max-h-80">
          {groups.map((group) => (
            <SelectGroup key={group.group}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.presets.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.label}
                  <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                    {preset.width}×{preset.height}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>

      {selected ? (
        <div className="space-y-1">
          <p className="font-mono text-[10px] text-muted-foreground">
            {describeImageSize(selected)}
            {selected.id === DEFAULT_IMAGE_SIZE_ID ? ' · spec default' : ''}
          </p>

          {selected.note && (
            <p className="text-[10px] text-muted-foreground">{selected.note}</p>
          )}

          {selected.offBrand && (
            <p className="flex items-start gap-1.5 text-[10px] text-amber-600">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              <span>
                Off-brand shape — every reference poster in the style spec is portrait.
                The renderer adapts (wide, then letterbox) and names any slot it has to
                drop, but the result will not match the reference set.
              </span>
            </p>
          )}

          {softPhoto && selected && (
            <p className="flex items-start gap-1.5 text-[10px] text-amber-600">
              <ImageOff className="mt-px h-3 w-3 shrink-0" />
              <span>
                Delivered at full {selected.width}×{selected.height} with sharp type, but
                the background photo is stretched about {photoUpscaleFactor(selected)}× —
                Flux renders no more than {FAL_MAX_EDGE} px per side.
              </span>
            </p>
          )}
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground">
          Falls back to <span className="font-mono">FAL_IMAGE_SIZE</span>, then to
          WhatsApp Status (1080×1920).
        </p>
      )}
    </div>
  );
}

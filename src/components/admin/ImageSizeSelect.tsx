'use client';

import * as React from 'react';

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
  getImageSizePreset,
  groupedImageSizePresets,
} from '@/lib/image-sizes';

/**
 * The output-size picker, shared by manual onboarding and the client detail
 * page so both surfaces offer the same catalogue in the same order.
 *
 * The selected preset's description and note render below the trigger rather
 * than inside the option rows: Radix renders the selected option's text into the
 * trigger, so anything extra placed there would leak into the closed control.
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

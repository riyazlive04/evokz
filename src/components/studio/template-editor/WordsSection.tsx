'use client';

import * as React from 'react';

import { EyeOff, Loader2, RotateCcw, Undo2, WandSparkles } from 'lucide-react';

import { EditorSection, FIELD_BUTTON_CLASS, FIELD_TEXTAREA_CLASS } from '@/components/studio/template-editor/editor-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  lengthGuide,
  normalizeFieldText,
  type EditorDraft,
  type EditorField,
  type FieldDraft,
  type WordGroup,
} from '@/lib/campaign/clone-editor-view';
import { MAX_ELEMENT_TEXT } from '@/lib/types/template-elements';
import { cn } from '@/lib/utils';

export interface FieldHandlers {
  onChange: (id: string, patch: Partial<FieldDraft>) => void;
  onFocus: (id: string) => void;
  onBlur: (id: string) => void;
}

/**
 * The template's words, one field each, in the order the poster reads — grouped
 * where the template groups them ("Features").
 *
 * Every field starts with the day's words. Under it: the template's own words
 * when they differ (faint), a character count against the template's, and a soft
 * warning past +20% — the design has only the template's room. "Reset" puts the
 * template's words back; "Remove" hides the element on this poster and folds the
 * field to one line with "Restore". An emptied field erases the text too, and
 * says so.
 */
export function WordsSection({
  groups,
  draft,
  defaults,
  focusedId,
  disabled,
  handlers,
  rewrite,
}: {
  groups: WordGroup[];
  draft: EditorDraft;
  /** A fresh clone's values: what Reset returns a field to. */
  defaults: EditorDraft;
  focusedId: string | null;
  disabled: boolean;
  handlers: FieldHandlers;
  rewrite: { enabled: boolean; pending: boolean; reason: string | null; onClick: () => void };
}) {
  return (
    <EditorSection
      id="editor-words"
      title="Words"
      action={
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-[11px] [&_svg]:size-3.5"
          disabled={!rewrite.enabled || rewrite.pending}
          title={rewrite.reason ?? undefined}
          onClick={rewrite.onClick}
        >
          {rewrite.pending ? <Loader2 className="animate-spin" /> : <WandSparkles />}
          Rewrite with AI
        </Button>
      }
      description="Change any wording. Rewrite with AI writes fresh wording for every shown text, each close to its template length; the business name, phone, website and logo are never changed."
    >
      {groups.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">This template has no words to edit.</p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) =>
            group.title ? (
              <fieldset key={group.key} className="space-y-2.5 rounded-md border border-border p-2.5">
                <legend className="px-1 text-[11px] font-medium text-muted-foreground">
                  {group.title} <span className="font-mono text-muted-foreground/70">{group.fields.length}</span>
                </legend>
                {group.fields.map((field) => (
                  <WordField
                    key={field.id}
                    field={field}
                    value={draft[field.id]}
                    defaultText={defaults[field.id]?.text ?? ''}
                    focused={focusedId === field.id}
                    disabled={disabled}
                    handlers={handlers}
                  />
                ))}
              </fieldset>
            ) : (
              group.fields.map((field) => (
                <WordField
                  key={field.id}
                  field={field}
                  value={draft[field.id]}
                  defaultText={defaults[field.id]?.text ?? ''}
                  focused={focusedId === field.id}
                  disabled={disabled}
                  handlers={handlers}
                />
              ))
            ),
          )}
        </div>
      )}
    </EditorSection>
  );
}

function WordField({
  field,
  value,
  defaultText,
  focused,
  disabled,
  handlers,
}: {
  field: EditorField;
  value: FieldDraft | undefined;
  defaultText: string;
  focused: boolean;
  disabled: boolean;
  handlers: FieldHandlers;
}) {
  const current = value ?? { text: '', removed: false };
  const inputId = `editor-field-${field.id}`;
  const hintId = `${inputId}-hint`;

  // Remove and Restore each unmount the button just pressed: hand focus to the one that replaces it.
  const removeRef = React.useRef<HTMLButtonElement>(null);
  const restoreRef = React.useRef<HTMLButtonElement>(null);
  const moveFocusRef = React.useRef(false);
  React.useEffect(() => {
    if (!moveFocusRef.current) return;
    moveFocusRef.current = false;
    (current.removed ? restoreRef : removeRef).current?.focus();
  }, [current.removed]);

  if (current.removed) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-border px-2.5 py-1 text-[12px] text-muted-foreground">
        <span className="min-w-0 truncate">
          <span className="font-medium text-foreground/80">{field.label}</span> · Removed
        </span>
        <Button
          ref={restoreRef}
          size="sm"
          variant="ghost"
          className={FIELD_BUTTON_CLASS}
          disabled={disabled}
          aria-label={`Restore ${field.label}`}
          onClick={() => {
            moveFocusRef.current = true;
            handlers.onChange(field.id, { removed: false });
            handlers.onBlur(field.id);
          }}
        >
          <Undo2 aria-hidden />
          Restore
        </Button>
      </div>
    );
  }

  const guide = lengthGuide(current.text, field.templateText);
  const differs = normalizeFieldText(current.text) !== normalizeFieldText(defaultText);
  const empty = normalizeFieldText(current.text) === null;
  // Decided by the template alone: switching element type while typing would drop focus.
  const multiline = field.kind === 'body' || (field.templateText?.length ?? 0) > 40;
  const common = {
    id: inputId,
    value: current.text,
    disabled,
    maxLength: MAX_ELEMENT_TEXT,
    'aria-describedby': hintId,
    onFocus: () => handlers.onFocus(field.id),
    onBlur: () => handlers.onBlur(field.id),
  };

  return (
    <div className={cn('-mx-1 space-y-1 rounded-md px-1 py-0.5 transition-colors', focused && 'bg-muted/60')}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={inputId} className="min-w-0 truncate text-[12px] font-medium text-foreground">
          {field.label}
        </label>
        <div className="flex shrink-0 items-center">
          {differs && defaultText && (
            <Button
              size="sm"
              variant="ghost"
              className={FIELD_BUTTON_CLASS}
              disabled={disabled}
              aria-label={`Reset ${field.label} to the template's words`}
              onClick={() => {
                handlers.onChange(field.id, { text: defaultText });
                handlers.onBlur(field.id);
              }}
            >
              <RotateCcw aria-hidden />
              Reset
            </Button>
          )}
          <Button
            ref={removeRef}
            size="sm"
            variant="ghost"
            className={FIELD_BUTTON_CLASS}
            disabled={disabled}
            aria-label={`Remove ${field.label} from this poster`}
            onClick={() => {
              moveFocusRef.current = true;
              handlers.onChange(field.id, { removed: true });
              handlers.onBlur(field.id);
            }}
          >
            <EyeOff aria-hidden />
            Remove
          </Button>
        </div>
      </div>

      {multiline ? (
        <textarea {...common} rows={2} className={FIELD_TEXTAREA_CLASS} onChange={(event) => handlers.onChange(field.id, { text: event.target.value })} />
      ) : (
        <Input {...common} onChange={(event) => handlers.onChange(field.id, { text: event.target.value })} />
      )}

      <div id={hintId} className="flex items-start justify-between gap-2 text-[10px] leading-snug">
        <span className="min-w-0 break-words text-muted-foreground/80">
          {empty ? 'Empty — this text is erased from the poster.' : differs && defaultText ? `Template: “${defaultText}”` : null}
        </span>
        {guide.templateLength !== null && (
          <span className={cn('shrink-0 font-mono tabular-nums', guide.over ? 'text-warning-ink' : 'text-muted-foreground/80')}>
            {guide.count}/{guide.templateLength}
          </span>
        )}
      </div>
      {guide.over && (
        <p className="text-[10px] text-warning-ink">
          Much longer than the template&apos;s {guide.templateLength} characters — it may not fit its space.
        </p>
      )}
    </div>
  );
}

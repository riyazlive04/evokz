'use client';

import * as React from 'react';

import { Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';

import {
  createCategory,
  deleteCategory,
  updateCategory,
} from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAction } from '@/hooks/use-action';

export interface CategoryRow {
  id: string;
  name: string;
  clientCount: number;
}

export function CategoryManager({ categories }: { categories: CategoryRow[] }) {
  const [name, setName] = React.useState('');
  const create = useAction(createCategory);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    const result = await create.run({ name });
    if (result.ok) setName('');
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleCreate} className="space-y-1.5">
        <Label htmlFor="category-name">Business vertical</Label>
        <div className="flex gap-2">
          <Input
            id="category-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Heavy Construction"
            maxLength={120}
            required
          />
          <Button type="submit" disabled={create.pending} className="shrink-0">
            {create.pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Ingest
          </Button>
        </div>
      </form>

      {create.error && (
        <p role="alert" className="text-[11px] text-red-600">
          {create.error}
        </p>
      )}

      {categories.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          No verticals ingested yet.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {categories.map((category) => (
            <CategoryRowItem key={category.id} category={category} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CategoryRowItem({ category }: { category: CategoryRow }) {
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(category.name);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const update = useAction(updateCategory);
  const remove = useAction(deleteCategory);

  React.useEffect(() => {
    if (!editing) setName(category.name);
  }, [editing, category.name]);

  async function handleSave() {
    const result = await update.run(category.id, { name });
    if (result.ok) setEditing(false);
  }

  return (
    <li className="py-2">
      <div className="flex items-center gap-2">
        {editing ? (
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            aria-label="Vertical name"
          />
        ) : (
          <>
            <span className="flex-1 truncate text-sm text-foreground">{category.name}</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {category.clientCount} client{category.clientCount === 1 ? '' : 's'}
            </span>
          </>
        )}

        <div className="flex shrink-0 items-center gap-1">
          {editing ? (
            <>
              <Button
                size="icon"
                variant="ghost"
                onClick={handleSave}
                disabled={update.pending}
                aria-label="Save vertical"
              >
                {update.pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4 text-emerald-600" />
                )}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  setName(category.name);
                  update.reset();
                  setEditing(false);
                }}
                aria-label="Cancel"
              >
                <X className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setEditing(true)}
                aria-label={`Edit ${category.name}`}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() =>
                  confirmDelete ? void remove.run(category.id) : setConfirmDelete(true)
                }
                disabled={remove.pending}
                aria-label={
                  confirmDelete ? `Confirm delete ${category.name}` : `Delete ${category.name}`
                }
                className={confirmDelete ? 'text-red-600' : ''}
              >
                {remove.pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </Button>
            </>
          )}
        </div>
      </div>

      {confirmDelete && !remove.error && (
        <p className="mt-1 flex items-center gap-3 text-[11px] text-amber-600">
          Click delete again to confirm.
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => setConfirmDelete(false)}
          >
            Cancel
          </button>
        </p>
      )}
      {(update.error || remove.error) && (
        <p role="alert" className="mt-1 text-[11px] text-red-600">
          {update.error ?? remove.error}
        </p>
      )}
    </li>
  );
}

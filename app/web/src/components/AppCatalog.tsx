import type { ReactNode } from 'react';
import { Check, Plus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

// One selectable agent in the catalog. `added` means it's already showing in the
// nav (so the tile is a no-op check rather than an add button). Keys are plain
// strings to keep this component free of the App's Page union / import cycle.
// `group` is the nav section it belongs to ("Collab agents" / "Work agents").
export type CatalogApp = {
  key: string;
  icon: ReactNode;
  label: string;
  description: string;
  added: boolean;
  group?: string;
};

// Each nav group opens its OWN catalog: collab agents reach into what the team
// knows, work agents act on your own material, and the two are never browsed as
// one undifferentiated grid. The copy is per-group for the same reason — the
// distinction is the product, so every line names the kind of agent you're
// adding rather than a generic "app".
type GroupCopy = {
  title: string;
  description: string;
};

const GROUP_COPY: Record<string, GroupCopy> = {
  'Collab agents': {
    title: 'Add a collab agent',
    description:
      'Collab agents reach into what your team knows. Pick one to add to your sidebar.',
  },
  'Work agents': {
    title: 'Add a work agent',
    description:
      'Work agents act on your own material. Pick one to add to your sidebar.',
  },
};

const FALLBACK_COPY: GroupCopy = {
  title: 'Add an agent',
  description: 'Pick an agent to add to your sidebar.',
};

export function AppCatalog({
  group,
  onOpenChange,
  apps,
  onAdd,
}: {
  // Which group's catalog is open — null when none is. One component, one modal
  // at a time, scoped to the group whose "+" was clicked.
  group: string | null;
  onOpenChange: (open: boolean) => void;
  apps: CatalogApp[];
  onAdd: (key: string) => void;
}) {
  const copy = (group && GROUP_COPY[group]) || FALLBACK_COPY;
  const groupApps = apps.filter((a) => (a.group ?? '') === (group ?? ''));

  return (
    <Dialog open={!!group} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-5 overflow-y-auto">
          <div className="grid gap-2 sm:grid-cols-2">
            {groupApps.map((app) => (
              <div
                key={app.key}
                className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
              >
                <span className="mt-0.5 text-muted-foreground">{app.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{app.label}</div>
                  <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                    {app.description}
                  </p>
                </div>
                {app.added ? (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground">
                    <Check className="size-3.5" />
                    Added
                  </span>
                ) : (
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-muted"
                    onClick={() => onAdd(app.key)}
                  >
                    <Plus className="size-3.5" />
                    Add
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState, type ReactNode } from 'react';
import { FolderOpen, UserRound, Plus, ChevronDown, X } from 'lucide-react';
import { api, type TeamUser } from '../api.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

// A folder/teammate reference the user picked — a folder id, a teammate email,
// or a free-typed name/@handle. Resolution to a real folder happens server-side.
export type TargetRef = { ref: string; label: string };

// The shared "which folders" picker used by Ask, Updates (watch scope) and
// Alignment (check against): a "This folder" self toggle, added chips, and a
// dropdown of your other folders + teammates (plus a free-type escape hatch).
// Target state is controlled by the parent; the folder/teammate catalog and the
// free-type draft are owned here.
export function FolderTargetPicker({
  wsId,
  includeSelf,
  targetRefs,
  onToggleSelf,
  onAdd,
  onRemove,
  label,
  icon,
  selfLabel = 'This directory',
  helper,
}: {
  wsId: string;
  includeSelf: boolean;
  targetRefs: TargetRef[];
  onToggleSelf: () => void;
  onAdd: (ref: string, label?: string) => void;
  onRemove: (ref: string) => void;
  /** Eyebrow label above the chips, e.g. "Check against" / "Ask". Omit to let
   * the parent supply its own field label. */
  label?: ReactNode;
  /** Optional eyebrow icon (only rendered alongside `label`). */
  icon?: ReactNode;
  /** Label for the current-folder toggle chip. */
  selfLabel?: string;
  /** Helper text under the chips. */
  helper?: ReactNode;
}) {
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [team, setTeam] = useState<TeamUser[]>([]);
  const [refDraft, setRefDraft] = useState('');

  // Other folders you belong to + teammates (their folder), for the dropdown.
  useEffect(() => {
    api
      .listWorkspaces()
      .then((r) => setFolders(r.workspaces.filter((w) => w.id !== wsId)))
      .catch(() => setFolders([]));
    api
      .teamDirectory()
      .then((t) => setTeam(t.users.filter((u) => u.user_id !== t.me.user_id)))
      .catch(() => setTeam([]));
  }, [wsId]);

  const add = (ref: string, l?: string) => {
    const r = ref.trim();
    if (!r) return;
    onAdd(r, l);
    setRefDraft('');
  };

  return (
    <div className="space-y-1.5">
      {label && (
        <div className="eyebrow flex items-center gap-1.5">
          {icon} {label}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleSelf}
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
            includeSelf
              ? 'border-transparent bg-secondary text-secondary-foreground'
              : 'border-dashed text-muted-foreground line-through'
          }`}
          title={includeSelf ? 'Remove this directory' : 'Add this directory back'}
        >
          {selfLabel} {includeSelf && <X className="size-3" />}
        </button>
        {targetRefs.map((t) => (
          <span
            key={t.ref}
            className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground"
          >
            {t.label}
            <button type="button" onClick={() => onRemove(t.ref)} aria-label={`Remove ${t.label}`}>
              <X className="size-3" />
            </button>
          </span>
        ))}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <Plus className="size-3" /> Add directory or teammate <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
            {folders.length > 0 && (
              <>
                <DropdownMenuLabel className="text-[11px]">Your directories</DropdownMenuLabel>
                {folders
                  .filter((w) => !targetRefs.some((t) => t.ref === w.id))
                  .map((w) => (
                    <DropdownMenuItem key={w.id} onSelect={() => add(w.id, w.name)}>
                      <FolderOpen className="size-3.5 text-muted-foreground" /> {w.name}
                    </DropdownMenuItem>
                  ))}
              </>
            )}
            {team.length > 0 && (
              <>
                {folders.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-[11px]">Teammates (their directory)</DropdownMenuLabel>
                {team
                  .filter((u) => !targetRefs.some((t) => t.ref === u.email))
                  .map((u) => (
                    <DropdownMenuItem key={u.user_id} onSelect={() => add(u.email, u.display_name ?? u.email)}>
                      <UserRound className="size-3.5 text-muted-foreground" /> {u.display_name ?? u.email}
                    </DropdownMenuItem>
                  ))}
              </>
            )}
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5">
              <div className="mb-1 text-[11px] text-muted-foreground">Or a directory name / email</div>
              <div className="flex gap-1">
                <Input
                  value={refDraft}
                  onChange={(e) => setRefDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      add(refDraft);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="name, email, @handle"
                  className="h-7 text-xs"
                />
                <Button type="button" size="sm" variant="secondary" className="h-7" onClick={() => add(refDraft)}>
                  Add
                </Button>
              </div>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {helper && <p className="text-xs text-muted-foreground">{helper}</p>}
    </div>
  );
}

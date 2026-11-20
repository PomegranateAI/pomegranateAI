import { useEffect, useState } from 'react';
import { FolderPlus } from 'lucide-react';
import { fetchProfileCatalog } from '../profiles.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Create-a-subfolder dialog. A subfolder is a subgraph, and every subgraph is
 * bound to a context profile — but there is only one built-in template
 * (`notes`), so there is nothing to pick. The dialog just asks for a name and
 * an optional description; `onCreate` gets the resolved profile id (fetched
 * from the server catalog so this never hardcodes it), the (trimmed) name,
 * and the (trimmed) description — an empty description defaults to
 * "miscellaneous" server-side.
 */
export function SubfolderDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (profileId: string, name: string, description: string) => Promise<void> | void;
}) {
  const [profileId, setProfileId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  // Resolve the (single) template once the dialog is first opened.
  useEffect(() => {
    if (!open || profileId) return;
    fetchProfileCatalog()
      .then((ps) => setProfileId(ps[0]?.id ?? null))
      .catch(() => setProfileId(null));
  }, [open, profileId]);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setBusy(false);
    }
  }, [open]);

  const submit = async () => {
    if (!profileId || !name.trim() || busy) return;
    setBusy(true);
    try {
      await onCreate(profileId, name.trim(), description.trim());
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>Name it, then optionally describe what it's for.</DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <label htmlFor="subfolder-name" className="eyebrow">
            Name
          </label>
          <Input
            id="subfolder-name"
            value={name}
            placeholder="e.g. Product"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="subfolder-description" className="eyebrow">
            Description <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Input
            id="subfolder-description"
            value={description}
            placeholder="e.g. Product ground truth for the Pomegranate Slack app"
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <p className="text-xs text-muted-foreground">
            What this folder is for. Defaults to “miscellaneous” if left blank.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!profileId || !name.trim() || busy}>
            <FolderPlus className="size-4" />
            {busy ? 'Creating…' : 'Create folder'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

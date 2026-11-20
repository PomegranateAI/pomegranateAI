import { useEffect, useState } from 'react';
import { RefreshCw, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, type Subgraph } from '../api.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { AUDIENCE_TIERS, type Audience } from '../audience.js';

/**
 * Per-subfolder settings: the two text inputs routing reads (owner
 * description + content summary) and the routable switch. Both text fields
 * double as what the ingest router and query classifier see —
 * `buildDocumentRouteCatalog`'s `owner_says`/`currently_holds` — so this is
 * also, deliberately, a routing-tuning surface, not just cosmetic metadata.
 */
export function SubfolderSettingsDialog({
  open,
  onOpenChange,
  wsId,
  subgraph,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wsId: string;
  subgraph: Subgraph | null;
  /** Called after any successful save so the caller can refresh its list. */
  onSaved: () => void;
}) {
  const [description, setDescription] = useState('');
  const [summary, setSummary] = useState('');
  const [locked, setLocked] = useState(false);
  const [routable, setRoutable] = useState(true);
  const [defaultAudience, setDefaultAudience] = useState<Audience | ''>('');
  const [busy, setBusy] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // Reset the form from the current row every time a (different) subfolder
  // is opened — this dialog doesn't own the data, Setup's list does.
  useEffect(() => {
    if (!open || !subgraph) return;
    setDescription(subgraph.description === 'miscellaneous' ? '' : subgraph.description);
    setSummary(subgraph.generated_description ?? '');
    setLocked(subgraph.generated_description_locked);
    setRoutable(subgraph.routable);
    setDefaultAudience(subgraph.default_audience ?? '');
  }, [open, subgraph]);

  if (!subgraph) return null;

  async function save() {
    if (!subgraph || busy) return;
    setBusy(true);
    try {
      // Only send what actually changed, so an untouched summary never
      // accidentally (re)locks itself against the automatic refresh.
      const body: {
        description?: string;
        generated_description?: string;
        routable?: boolean;
        default_audience?: Audience | null;
      } = {};
      if (description.trim() !== (subgraph.description === 'miscellaneous' ? '' : subgraph.description)) {
        body.description = description;
      }
      const trimmedSummary = summary.trim();
      if (trimmedSummary && trimmedSummary !== (subgraph.generated_description ?? '')) {
        body.generated_description = trimmedSummary;
      }
      if (routable !== subgraph.routable) body.routable = routable;
      if ((defaultAudience || null) !== (subgraph.default_audience ?? null)) {
        body.default_audience = defaultAudience || null;
      }
      if (Object.keys(body).length === 0) {
        onOpenChange(false);
        return;
      }
      const r = await api.updateSubgraph(wsId, subgraph.id, body);
      setLocked(r.generated_description_locked);
      toast.success('Folder settings saved', { description: subgraph.name });
      onSaved();
      onOpenChange(false);
    } catch (e: any) {
      toast.error('Could not save settings', {
        description: /403|forbidden/i.test(e?.message ?? '') ? 'Only workspace admins can edit this.' : e?.message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    if (!subgraph || regenerating) return;
    setRegenerating(true);
    try {
      const r = await api.regenerateSubgraphSummary(wsId, subgraph.id);
      setSummary(r.summary ?? '');
      setLocked(false);
      toast.success('Summary regenerated');
      onSaved();
    } catch (e: any) {
      toast.error('Could not regenerate', { description: e?.message });
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="size-4" /> {subgraph.name}
          </DialogTitle>
          <DialogDescription>
            Both fields below are what routing reads when it decides whether a document belongs here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <label htmlFor="sf-description" className="eyebrow">
            Description <span className="font-normal text-muted-foreground">(what this is for)</span>
          </label>
          <Textarea
            id="sf-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Product ground truth for the Pomegranate Slack app"
            rows={2}
          />
          <p className="text-xs text-muted-foreground">
            Your own one-line statement of intent. Outranks inference — set at onboarding, editable any time.
            Blank resets to “miscellaneous.”
          </p>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label htmlFor="sf-summary" className="eyebrow">
              Content summary <span className="font-normal text-muted-foreground">(what this currently holds)</span>
            </label>
            <button
              type="button"
              onClick={() => void regenerate()}
              disabled={regenerating || busy}
              className="inline-flex items-center gap-1 text-xs text-pome-red hover:underline disabled:opacity-40"
            >
              <RefreshCw className={`size-3 ${regenerating ? 'animate-spin' : ''}`} />
              {regenerating ? 'Regenerating…' : 'Regenerate'}
            </button>
          </div>
          <Textarea
            id="sf-summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="(empty — nothing filed here yet)"
            rows={4}
          />
          <p className="text-xs text-muted-foreground">
            {locked
              ? 'Hand-edited — the automatic refresh (every ingest, opening Overview) will leave this alone until you regenerate it.'
              : 'Auto-synthesized from the graph and refreshed on every ingest. Editing it here locks it against that refresh.'}
          </p>
        </div>

        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <p className="text-sm font-medium text-ink">Routable</p>
            <p className="text-xs text-muted-foreground">
              {routable
                ? 'The router can file a document here on its own.'
                : 'Only reachable by an explicit #slug pin or a direct “add to this folder” pick — automatic routing skips it.'}
            </p>
          </div>
          <Switch checked={routable} onCheckedChange={setRoutable} aria-label="Routable" />
        </div>

        <div className="space-y-1">
          <label htmlFor="sf-default-audience" className="eyebrow">
            Default privacy <span className="font-normal text-muted-foreground">(for new notes)</span>
          </label>
          <select
            id="sf-default-audience"
            value={defaultAudience}
            onChange={(e) => setDefaultAudience(e.target.value as Audience | '')}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">Not set — notes added in the app default to Only me</option>
            {AUDIENCE_TIERS.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label} — {t.hint}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Who can see a note filed into this folder when no privacy was picked for it. Changing this
            doesn’t touch notes already here.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

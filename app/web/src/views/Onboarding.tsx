import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api.js';
import { fetchProfileCatalog } from '../profiles.js';
import { setWorkspaceId } from '../api.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { AiDirectoryAccess } from '../components/AiDirectoryAccess.js';

export function Onboarding({
  workspaces,
  onSelect,
  onCreated,
}: {
  workspaces: Array<{ id: string; name: string; can_manage?: boolean }>;
  onSelect: (id: string) => void;
  onCreated: (id: string, name: string) => void;
}) {
  const [name, setName] = useState('');
  // There is only one built-in template — resolved once so `create` never
  // hardcodes the id — so the picker step from when there were several is
  // gone; a folder's one subfolder is created with it automatically.
  const [profileId, setProfileId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchProfileCatalog().then((ps) => setProfileId((cur) => cur ?? ps[0]?.id ?? null));
  }, []);

  async function create() {
    if (!name.trim() || !profileId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.createWorkspace(name, [profileId]);
      toast.success('Directory created', { description: r.name });
      // Point the API client at the new workspace and go straight in — a new
      // folder has nothing connected or added yet, so the app lands on Get started.
      setWorkspaceId(r.id);
      onCreated(r.id, r.name);
    } catch (e: any) {
      setErr(e.message);
      toast.error('Could not create directory', { description: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-page min-h-screen px-6 py-16">
      <div className="mx-auto max-w-3xl space-y-8">
        <div className="text-center">
          <p className="eyebrow">name your directory</p>
          <h2 className="mt-2 font-serif text-4xl italic text-ink">Directories</h2>
        </div>

        {workspaces.length > 0 && (
          <Card className="shadow-soft">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Your directories</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {workspaces.map((w) => (
                  <li key={w.id} className="flex flex-wrap items-center justify-between gap-3">
                    <button
                      onClick={() => onSelect(w.id)}
                      className="rounded-md px-2 py-1 text-left font-medium text-ink transition-colors hover:bg-muted"
                    >
                      {w.name}
                    </button>
                    <div className="flex flex-wrap items-center gap-3">
                      <AiDirectoryAccess wsId={w.id} canManage={!!w.can_manage} compact />
                      <code className="font-mono text-xs text-muted-foreground">{w.id}</code>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle className="text-base">Create a new directory</CardTitle>
            <CardDescription>One directory per user. Documents you add get routed into it automatically.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ws-name">Directory name</Label>
              <Input
                id="ws-name"
                placeholder="My company"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && name.trim()) create();
                }}
              />
            </div>
            <button className="pome-btn" disabled={!name.trim() || !profileId || busy} onClick={create}>
              {busy ? 'Creating…' : 'Create'}
            </button>
            {err && <p className="text-sm text-destructive">{err}</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

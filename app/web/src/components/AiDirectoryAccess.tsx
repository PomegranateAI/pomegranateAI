import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export function AiDirectoryAccess({ wsId, canManage, compact = false }: { wsId: string; canManage?: boolean; compact?: boolean }) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [mayChange, setMayChange] = useState(canManage ?? false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setAllowed(null);
    api.getAiAccess(wsId).then((r) => { if (live) setAllowed(r.ai_allowed); }).catch(() => {});
    if (canManage === undefined) {
      api.listWorkspaces().then((r) => {
        if (live) setMayChange(!!r.workspaces.find((w) => w.id === wsId)?.can_manage);
      }).catch(() => {});
    } else {
      setMayChange(canManage);
    }
    return () => { live = false; };
  }, [wsId, canManage]);

  async function toggle() {
    if (allowed === null || !mayChange || busy) return;
    setBusy(true);
    try {
      const next = await api.setAiAccess(wsId, !allowed);
      setAllowed(next.ai_allowed);
      toast.success(next.ai_allowed ? 'AI access allowed' : 'AI access blocked');
    } catch (err: any) {
      toast.error('Could not update AI access', { description: err.message });
    } finally {
      setBusy(false);
    }
  }

  const control = (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={allowed ?? true} disabled={allowed === null || !mayChange || busy} onChange={() => void toggle()} />
      <span>Allow AI access</span>
    </label>
  );
  if (compact) return control;
  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="font-serif text-2xl italic">AI access</CardTitle>
        <CardDescription>When off, AI agents cannot access or list this directory. People can still use it in the app.</CardDescription>
      </CardHeader>
      <CardContent>{control}</CardContent>
    </Card>
  );
}

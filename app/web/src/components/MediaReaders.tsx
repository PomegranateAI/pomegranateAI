import { useEffect, useState } from 'react';
import { api, type MediaReaderBinding } from '../api';

/**
 * Media readers bound to a SURFACE connection (WhatsApp) rather than a
 * subfolder — Setup's "WhatsApp media readers" block.
 *
 * The subfolder half of this component moved into DataAgents.tsx: in a
 * folder, readers are one stage of the data-agent pipeline and belong in
 * that roster alongside the capture agent. A surface has no capture agent
 * and no folder of its own — the reader result goes to the conversational
 * agent — so there is nothing here to unify it with, and the output/jobs
 * controls that panel carries don't apply.
 */
export function MediaReaders({ wsId, target }: { wsId: string; target: string }) {
  const [bindings, setBindings] = useState<MediaReaderBinding[]>([]);
  const [manage, setManage] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .mediaReaders(wsId, target)
      .then((r) => {
        if (live) {
          setBindings(r.bindings);
          setManage(r.can_manage);
        }
      })
      .catch(() => {
        if (live) setError('Could not load media readers.');
      });
    return () => {
      live = false;
    };
  }, [wsId, target]);
  async function save(capability: 'audio' | 'image', enabled: boolean, config: MediaReaderBinding['config']) {
    setBusy(true);
    setError('');
    try {
      await api.setMediaReader(wsId, target, capability, { enabled, config });
      const r = await api.mediaReaders(wsId, target);
      setBindings(r.bindings);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rounded-lg border p-3 text-sm">
      <summary className="cursor-pointer font-medium">WhatsApp media readers</summary>
      <p className="my-2 text-xs text-muted-foreground">
        Read voice messages and images using your connected assistant.
      </p>
      {(['audio', 'image'] as const).map((capability) => {
        const binding = bindings.find((b) => b.capability === capability);
        // A surface with no row yet is ON: WhatsApp media arrives whether or
        // not anyone visited this screen, and silently dropping it would read
        // as the bot ignoring the message.
        const enabled = binding ? !!binding.enabled : true;
        const config = binding?.config ?? { output: 'capture' as const };
        return (
          <div className="my-3 flex flex-wrap items-center gap-3" key={capability}>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={!manage || busy}
                checked={enabled}
                onChange={(e) => void save(capability, e.target.checked, config)}
              />
              {capability === 'audio' ? 'Transcribe audio' : 'Read images'}
            </label>
            {capability === 'audio' && (
              <label className="text-xs">
                Language{' '}
                <input
                  key={config.language ?? ''}
                  aria-label="Audio language"
                  className="w-24 rounded border bg-background p-1"
                  placeholder="English"
                  defaultValue={config.language ?? ''}
                  disabled={!manage || busy}
                  onBlur={(e) => {
                    const language = e.target.value.trim() || undefined;
                    if (language !== config.language) void save(capability, enabled, { ...config, language });
                  }}
                />
              </label>
            )}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Original files are private to the uploader until explicitly shared from a node.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
    </details>
  );
}

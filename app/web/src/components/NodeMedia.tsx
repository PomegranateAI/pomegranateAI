import { useEffect, useState } from 'react';
import { api, type MediaAttachment } from '../api';

/**
 * The originals behind a node or a source document — the audio/image itself,
 * AND the text a data agent read out of it (a voice note's transcript, an
 * image's OCR). Both matter: the media is the evidence, the text is what the
 * graph was actually built from, and a node that offers only playback leaves
 * the reader no way to see what was understood.
 */
export function MediaAttachments({
  wsId,
  nodeId,
  documentId,
}: {
  wsId: string;
  nodeId?: string;
  documentId?: string;
}) {
  const [assets, setAssets] = useState<MediaAttachment[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setAssets([]);
    setError('');
    const load = nodeId ? api.nodeAssets(wsId, nodeId) : documentId ? api.documentAssets(wsId, documentId) : null;
    if (!load) return;
    load
      .then((r) => {
        if (live) setAssets(r.assets);
      })
      .catch(() => {
        if (live) setError('Could not load original files.');
      });
    return () => {
      live = false;
    };
  }, [wsId, nodeId, documentId]);
  if (!assets.length && !error) return null;
  return (
    <div className="mt-3 space-y-2">
      {assets.map((a) => (
        <Attachment key={a.id} wsId={wsId} asset={a} />
      ))}
      {error && <p className="text-xs text-muted-foreground">{error}</p>}
    </div>
  );
}

/** Back-compat wrapper: the node view's original entry point. */
export function NodeMedia({ wsId, nodeId }: { wsId: string; nodeId: string }) {
  return <MediaAttachments wsId={wsId} nodeId={nodeId} />;
}

function Attachment({ wsId, asset }: { wsId: string; asset: MediaAttachment }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [visibility, setVisibility] = useState(asset.visibility);
  const [text, setText] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const [textBusy, setTextBusy] = useState(false);
  const isAudio = asset.mime.startsWith('audio/');
  // `has_text` is absent on an older server response — stay optimistic and let
  // the click report a miss, rather than hiding a transcript that does exist.
  const mayHaveText = asset.has_text !== false;
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  async function open() {
    setBusy(true);
    try {
      const blob = await api.assetContent(wsId, asset.id);
      setUrl(URL.createObjectURL(blob));
    } catch {
      setError('Could not open the original file.');
    } finally {
      setBusy(false);
    }
  }
  async function loadText(): Promise<string | null> {
    if (text !== null) return text;
    setTextBusy(true);
    try {
      const r = await api.assetText(wsId, asset.id);
      setText(r.text);
      return r.text;
    } catch {
      setError(isAudio ? 'No transcript was stored for this recording.' : 'No text was read from this image.');
      return null;
    } finally {
      setTextBusy(false);
    }
  }
  async function toggleText() {
    if (showText) return setShowText(false);
    if ((await loadText()) !== null) setShowText(true);
  }
  async function downloadText() {
    const value = await loadText();
    if (value === null) return;
    const blob = new Blob([value], { type: 'text/plain;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `${asset.name.replace(/\.[a-z0-9]{1,5}$/i, '')}.txt`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
  }
  async function share() {
    try {
      const next = visibility === 'team' ? 'private' : 'team';
      await api.shareAsset(wsId, asset.id, next);
      setVisibility(next);
    } catch {
      setError('Could not change sharing.');
    }
  }
  return (
    <div className="rounded border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{asset.name}</span>
        <span className="text-muted-foreground">
          {Math.ceil(asset.bytes / 1024)} KB · {visibility === 'team' ? 'Shared original' : 'Private original'}
        </span>
        {!url && (
          <button className="underline" disabled={busy} onClick={() => void open()}>
            {busy ? 'Loading…' : 'Open original'}
          </button>
        )}
        {url && (
          <a className="underline" href={url} download={asset.name}>
            Download
          </a>
        )}
        {mayHaveText && (
          <button className="underline" disabled={textBusy} onClick={() => void toggleText()}>
            {textBusy ? 'Loading…' : showText ? 'Hide text' : isAudio ? 'Show transcript' : 'Show text'}
          </button>
        )}
        {mayHaveText && (
          <button className="underline" disabled={textBusy} onClick={() => void downloadText()}>
            Download text
          </button>
        )}
        {asset.can_share && (
          <button className="underline" onClick={() => void share()}>
            {visibility === 'team' ? 'Make original private' : 'Share original with directory'}
          </button>
        )}
      </div>
      {url && isAudio && <audio className="mt-2 w-full" controls src={url} />}
      {url && asset.mime.startsWith('image/') && (
        <a href={url} target="_blank" rel="noreferrer">
          <img className="mt-2 max-h-80 max-w-full rounded" src={url} alt={asset.name} />
        </a>
      )}
      {showText && text !== null && (
        <p className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 leading-relaxed">
          {text}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

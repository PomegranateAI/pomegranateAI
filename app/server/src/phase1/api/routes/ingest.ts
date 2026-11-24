// Routes: ingest.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { writeWorkspaceFile } from '../../files/sealed-files.js';
import { validateMedia } from '../../data-agents/validate-media.js';
import { MediaError } from '../../data-agents/media-service.js';
import { RedactionUnavailableError } from '../../ingest/redaction-error.js';
import { mediaMime, isMediaFilename } from '../../data-agents/media-types.js';
import { withMediaProvenance } from '../../data-agents/context.js';
import { z } from 'zod';
import { safeFetch, UnsafeUrlError, ResponseTooLargeError } from '../../../lib/safe-fetch.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { log } from '../../../lib/log.js';
import { ToolError } from '../../mcp/errors.js';
import { resolveFolderRef } from '../../mcp/folder-resolve.js';
import {
  extract,
  isSupported,
  extensionOf,
  htmlToMarkdown,
  mimeForExtension,
} from '../../ingest/extract.js';
import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerIngest(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  repo,
  runInstructedIngest,
  clientIp,
  runTextIngest,
  media,
  FILES_DIR,
} = core;
app.post('/workspaces/:ws/ingest', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const body = await c.req.json();
  const parsed = z
    .object({
      source: z.string().min(1),
      source_kind: z.enum(['doc', 'slack', 'transcript', 'interaction']).default('doc'),
      source_ref: z.string().optional(),
      // Explicit opt-in, separate from the ambient x-subgraph-id scoping
      // header — "I'm viewing this folder" must not silently start forcing
      // every paste into it.
      subgraph_id: z.string().optional(),
      // When set, an agent (not the plain router) decides how to shape and
      // where to file this document — see runInstructedIngest. Mutually
      // exclusive with subgraph_id in practice (the web UI hides the
      // destination picker once instructions are given); if both arrive, the
      // agent's own folder choice wins.
      instructions: z.string().min(1).optional(),
      // Explicit audience for the captured nodes (overrides the folder's default).
      audience: z.enum(['team', 'private', 'only_me']).optional(),
      // Used only when no explicit audience is given AND the destination
      // folder has no default_audience. The web app sends 'only_me'.
      default_audience: z.enum(['team', 'private', 'only_me']).optional(),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);

  if (parsed.data.subgraph_id && (await repo.getSubgraph(ws, parsed.data.subgraph_id))?.status !== 'active') {
    return c.json({ error: 'invalid_subgraph' }, 400);
  }

  if (parsed.data.instructions) {
    const result = await runInstructedIngest({
      ws,
      user_id: c.get('user_id'),
      instructions: parsed.data.instructions,
      source: parsed.data.source,
      source_kind: parsed.data.source_kind,
      source_ref: parsed.data.source_ref,
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
      audience: parsed.data.audience,
      fallbackAudience: parsed.data.default_audience,
    });
    return c.json({ agent: true, ...result });
  }

  const result = await runTextIngest({
    ws,
    user_id: c.get('user_id'),
    source: parsed.data.source,
    source_kind: parsed.data.source_kind,
    source_ref: parsed.data.source_ref,
    via: 'text',
    caller: 'api.ingest',
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    audience: parsed.data.audience,
    fallbackAudience: parsed.data.default_audience,
    forcedSubgraphId: parsed.data.subgraph_id,
  });
  return c.json({
    candidates: result.candidates,
    document_id: result.document_id,
    routed: result.routed,
    zero_yield: result.zero_yield,
    notice: result.notice,
    pending_approval: result.pending_approval,
    pending_route_id: result.pending_route_id,
  });
});

// ---------- file ingest (PDF / DOCX / VTT / TXT) ----------

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // Bounded in-memory processing.

app.post('/workspaces/:ws/ingest/file', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');

  const ctype = c.req.header('content-type') ?? '';
  if (!ctype.toLowerCase().startsWith('multipart/form-data')) {
    return c.json({ error: 'expected multipart/form-data' }, 400);
  }
  const form = await c.req.parseBody();
  const file = form['file'];
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'missing file field' }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: 'file too large', max_bytes: MAX_UPLOAD_BYTES }, 413);
  }
  if (!isSupported(file.name) && !isMediaFilename(file.name)) {
    return c.json({ error: 'unsupported_extension', ext: extensionOf(file.name) }, 415);
  }
  const subgraphIdField = typeof form['subgraph_id'] === 'string' ? form['subgraph_id'] : undefined;
  if (subgraphIdField && (await repo.getSubgraph(ws, subgraphIdField))?.status !== 'active') {
    return c.json({ error: 'invalid_subgraph' }, 400);
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (isMediaFilename(file.name)) {
    const mime = mediaMime(buf);
    if (!mime) return c.json({ error: 'unsupported_media' }, 415);
    const capability = mime.startsWith('image/') ? 'image' : 'audio';
    const target = subgraphIdField ?? 'default';
    const config = await media.binding(ws, `subgraph:${target}`, capability);
    if (!config)
      return c.json(
        { error: 'media_reader_required', detail: 'Attach an audio or image reader to the destination folder first.' },
        422,
      );
    try {
      await validateMedia(buf, mime);
      const asset = await media.upload(ws, user_id, file.name, mime, buf);
      const instructions = typeof form.instructions === 'string' ? form.instructions.trim() : undefined;
      const tier = z.enum(['team', 'private', 'only_me']);
      const explicit = tier.optional().catch(undefined).parse(form['audience']);
      const fallback = tier.optional().catch(undefined).parse(form['default_audience']);
      // Explicit choice → folder default → caller fallback → 'private'.
      const audience =
        explicit ?? (await repo.getSubgraph(ws, target))?.default_audience ?? fallback ?? 'private';
      const job = await media.createIngest(asset, { subgraph_id: target, config, audience, instructions });
      try {
        return c.json(await media.runIngest(ws, job, user_id));
      } catch (error) {
        if (error instanceof RedactionUnavailableError) {
          return c.json({ ...error.body(), job_id: job, asset_id: asset.id }, 422);
        }
        return c.json(
          {
            error: error instanceof MediaError ? error.code : 'media_processing_failed',
            job_id: job,
            asset_id: asset.id,
            detail: 'Processing will retry automatically. You can also retry from the folder’s media readers.',
          },
          error instanceof MediaError ? error.status : 503,
        );
      }
    } catch (error) {
      return c.json(
        {
          error: error instanceof MediaError ? error.code : 'media_processing_failed',
          detail: 'The original is retained. Retry the upload to resume processing.',
        },
        error instanceof MediaError ? error.status : 503,
      );
    }
  }
  const originalMime = mimeForExtension(extensionOf(file.name));
  const asset = await media.upload(ws, user_id, file.name, originalMime, buf);

  const sha = createHash('sha256').update(buf).digest('hex');

  log.info('ingest.file_received', {
    workspace: ws,
    user: user_id,
    filename: file.name,
    bytes: file.size,
    ext: extensionOf(file.name),
    sha: sha.slice(0, 12),
  });

  // Persist the raw file inside the workspace's files dir. Workspace deletion
  // (DELETE /workspaces/:ws) sweeps the whole dir.
  const wsDir = path.join(FILES_DIR, ws, 'sources');
  await fs.mkdir(wsDir, { recursive: true });
  const objectPath = path.join(ws, 'sources', sha + extensionOf(file.name));
  await writeWorkspaceFile(repo.crypto, ws, FILES_DIR, path.join(FILES_DIR, objectPath), buf);

  let extracted: Awaited<ReturnType<typeof extract>>;
  try {
    extracted = await extract(file.name, buf);
  } catch (err) {
    log.warn('ingest.extract_failed', {
      workspace: ws,
      filename: file.name,
      msg: (err as Error).message?.slice(0, 200),
    });
    return c.json({ error: 'extraction_failed', detail: (err as Error).message }, 422);
  }
  if (!extracted.text.trim()) {
    log.warn('ingest.extract_empty', { workspace: ws, filename: file.name, ext: extracted.ext });
    return c.json({ error: 'no_text_extracted', ext: extracted.ext }, 422);
  }
  log.info('ingest.extracted', {
    workspace: ws,
    via: 'file',
    filename: file.name,
    kind: extracted.kind,
    ext: extracted.ext,
    bytes: extracted.bytes,
    text_chars: extracted.text.length,
  });

  // Source row for traceability (referenced by candidates' source_ref).
  const source_id = `src_${nanoid(10)}`;
  await repo.insertSource({ id: source_id, ws, kind: extracted.kind, object_path: objectPath, original_name: file.name, sha256: sha });

  // From here on the file is just text: hand off to the ONE shared pipeline
  // (runTextIngest — redaction → registry → routing → capture fan-out). Do
  // not re-implement any of those steps here; the previous inline copy
  // drifted and silently skipped source-level redaction rules.
  const fileKind: 'doc' | 'transcript' = extracted.kind === 'transcript' ? 'transcript' : 'doc';
  const audienceField = typeof form['audience'] === 'string' ? form['audience'] : undefined;
  const audience = z.enum(['team', 'private', 'only_me']).optional().safeParse(audienceField);
  const fallbackField = typeof form['default_audience'] === 'string' ? form['default_audience'] : undefined;
  const fallback = z.enum(['team', 'private', 'only_me']).optional().safeParse(fallbackField);
  const fallbackAudience = fallback.success ? fallback.data : undefined;

  const instructionsField = typeof form['instructions'] === 'string' ? form['instructions'].trim() : '';
  if (instructionsField) {
    const agentResult = await withMediaProvenance([{workspace_id:ws,asset_id:asset.id}],()=>runInstructedIngest({
      ws,
      user_id,
      instructions: instructionsField,
      audience: audience.success ? audience.data : undefined,
      fallbackAudience,
      forcedSubgraph: subgraphIdField,
      source: extracted.text,
      source_kind: fileKind,
      source_ref: file.name,
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
    }));
    return c.json({
      agent: true,
      source_id,
      kind: extracted.kind,
      ext: extracted.ext,
      bytes: extracted.bytes,
      text_chars: extracted.text.length,
      ...agentResult,
    });
  }

  const result = await withMediaProvenance([{workspace_id:ws,asset_id:asset.id}],()=>runTextIngest({
    ws,
    user_id,
    source: extracted.text,
    source_kind: fileKind,
    source_ref: file.name,
    candidate_source_ref: `source:${source_id}`,
    via: 'file',
    caller: 'api.ingest_file',
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    audience: audience.success ? audience.data : undefined,
    fallbackAudience,
    forcedSubgraphId: subgraphIdField,
  }));
  return c.json({
    source_id,
    kind: extracted.kind,
    ext: extracted.ext,
    bytes: extracted.bytes,
    text_chars: extracted.text.length,
    candidates: result.candidates,
    document_id: result.document_id,
    routed: result.routed,
    zero_yield: result.zero_yield,
    notice: result.notice,
    pending_approval: result.pending_approval,
    pending_route_id: result.pending_route_id,
  });
});

// ---------- Alignment: extract text from a file or link (no ingest) ----------
//
// The "Alignment" experience checks an OUTSIDE deliverable (a doc, deck, PDF,
// or a link to one) against the canon of one or more folders. This endpoint
// only turns that upload into text — it never writes to the graph. The client
// then runs a review (POST /workspaces/:folder/reviews) against each selected
// folder with the returned text. File extraction reuses the ingest extractor;
// link extraction fetches the URL and reduces HTML to Markdown (best effort —
// auth-gated or binary links return a clear error).

const ALIGN_URL_MAX_BYTES = 5 * 1024 * 1024;

app.post('/workspaces/:ws/align/extract', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const ctype = (c.req.header('content-type') ?? '').toLowerCase();

  // Branch 1: uploaded file (multipart) — same extractor as /ingest/file.
  if (ctype.startsWith('multipart/form-data')) {
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!file || !(file instanceof File)) return c.json({ error: 'missing file field' }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large', max_bytes: MAX_UPLOAD_BYTES }, 413);
    if (!isSupported(file.name)) return c.json({ error: 'unsupported_extension', ext: extensionOf(file.name) }, 415);
    const buf = Buffer.from(await file.arrayBuffer());
    let extracted: Awaited<ReturnType<typeof extract>>;
    try {
      extracted = await extract(file.name, buf);
    } catch (err) {
      return c.json({ error: 'extraction_failed', detail: (err as Error).message?.slice(0, 200) }, 422);
    }
    if (!extracted.text.trim()) return c.json({ error: 'no_text_extracted', ext: extracted.ext }, 422);
    log.info('align.extract', { workspace: ws, user: c.get('user_id'), via: 'file', ext: extracted.ext, chars: extracted.text.length });
    return c.json({ text: extracted.text, source_ref: file.name, kind: extracted.kind });
  }

  // Branch 2: a link to a file/page.
  const parsed = z.object({ url: z.string().url() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid', detail: 'expected a file upload or a { url }' }, 400);
  let text = '';
  let ref = parsed.data.url;
  try {
    // safeFetch refuses private / loopback / link-local addresses (SSRF) on
    // every redirect hop, and enforces the size and time limits.
    let fetched: Awaited<ReturnType<typeof safeFetch>>;
    try {
      fetched = await safeFetch(parsed.data.url, { maxBytes: ALIGN_URL_MAX_BYTES, timeoutMs: 15_000, maxRedirects: 5 });
    } catch (err) {
      if (err instanceof UnsafeUrlError) return c.json({ error: 'link_not_allowed', detail: err.message }, 400);
      if (err instanceof ResponseTooLargeError) return c.json({ error: 'link_too_large', max_bytes: ALIGN_URL_MAX_BYTES }, 413);
      throw err;
    }
    if (fetched.status < 200 || fetched.status >= 300) return c.json({ error: 'link_unreachable', status: fetched.status }, 502);
    const linkType = fetched.contentType;
    const buf = fetched.body;
    const path = new URL(fetched.url).pathname;
    ref = path.split('/').filter(Boolean).pop() || parsed.data.url;
    if (linkType.includes('html') || (!linkType && /\.html?$/.test(path))) {
      text = htmlToMarkdown(buf.toString('utf8'));
    } else if (linkType.startsWith('text/') || /\.(txt|md|markdown|csv)$/.test(path)) {
      text = buf.toString('utf8');
    } else if (isSupported(ref)) {
      text = (await extract(ref, buf)).text;
    } else {
      // Fall back to treating it as HTML/text; many servers omit content-type.
      text = htmlToMarkdown(buf.toString('utf8'));
    }
  } catch (err) {
    return c.json({ error: 'link_fetch_failed', detail: (err as Error).message?.slice(0, 200) }, 502);
  }
  if (!text.trim()) return c.json({ error: 'no_text_extracted' }, 422);
  log.info('align.extract', { workspace: ws, user: c.get('user_id'), via: 'link', chars: text.length });
  return c.json({ text, source_ref: ref, kind: 'doc' });
});

// Resolve the Alignment "check against" references (folder ids, folder names,
// teammate emails/@handles, display names) to member folders — the same
// resolver the Updates target picker uses. Per-ref: a bad or forbidden ref is
// reported in `errors` instead of failing the whole batch, so the user still
// gets an alignment check against everything that did resolve.
app.post('/workspaces/:ws/align/resolve', authn, workspaceGate, async (c) => {
  const user_id = c.get('user_id');
  const parsed = z
    .object({ refs: z.array(z.string().min(1)).min(1).max(20) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);

  const resolved: Array<{ ref: string; workspace_id: string; name: string }> = [];
  const errors: Array<{ ref: string; detail: string }> = [];
  const seen = new Set<string>();
  for (const ref of parsed.data.refs) {
    try {
      const r = await resolveFolderRef(repo, user_id, ref, 'mcp');
      if (seen.has(r.workspace_id)) continue;
      seen.add(r.workspace_id);
      const w = await repo.getWorkspace(r.workspace_id);
      resolved.push({ ref, workspace_id: r.workspace_id, name: w?.name ?? r.workspace_id });
    } catch (err) {
      const detail = err instanceof ToolError ? String(err.extra.detail ?? err.code) : String(err);
      errors.push({ ref, detail });
    }
  }
  return c.json({ resolved, errors });
});
}

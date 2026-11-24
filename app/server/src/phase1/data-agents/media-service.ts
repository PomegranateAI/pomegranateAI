import { sealingAssetStore } from '../files/sealed-files.js';
import { RedactionUnavailableError } from '../ingest/redaction-error.js';
import { createHash } from 'node:crypto';
import type { Repo } from '../db/repo.js';
import { assetStores, type AssetStore } from './asset-store.js';
import { ReaderConfig, MAX_MEDIA_BYTES, type Asset, type MediaResult } from './media-types.js';
import { processorConfig, readMedia } from './read-media.js';
import { withLlmContext } from '../../lib/llm-context.js';

export interface MediaIngestInput {
  subgraph_id: string;
  config: ReaderConfig;
  audience: 'team' | 'private' | 'only_me';
  instructions?: string;
}
type IngestMedia = (
  asset: Asset,
  input: MediaIngestInput,
  processed: { run_id: string; result: MediaResult },
) => Promise<Record<string, unknown>>;
interface IngestJob {
  workspace_id: string;
  id: string;
  asset_id: string;
  user_id: string;
  payload: string;
  status: string;
  receipt: string | null;
  lease_until: number;
}

export class MediaError extends Error {
  constructor(
    public code: string,
    public status: 400 | 403 | 404 | 409 | 413 | 422 | 503 = 422,
  ) {
    super(code);
  }
}
export interface MediaProvenance {
  workspace_id: string;
  asset_id: string;
  run_id?: string;
}

export class MediaService {
  ingest?: IngestMedia;
  /** Standalone injects its own trusted identity gate; cloud uses membership. */
  canIngest: (ws: string, user: string) => Promise<boolean> = async (ws, user) => !!(await this.repo.getMembership(ws, user));
  private stores: Record<string, AssetStore>;
  private current: AssetStore;
  constructor(
    readonly repo: Repo,
    root: string,
    private reader = readMedia,
    store?: AssetStore,
  ) {
    const configured = store ? { current: store, stores: { [store.backend]: store } } : assetStores(root);
    // Media originals are sealed with the workspace key when sealing is on
    // (files/sealed-files.ts); repo.crypto is read per call.
    const seal = (st: AssetStore) => sealingAssetStore(st, () => this.repo.crypto);
    this.stores = Object.fromEntries(Object.entries(configured.stores).map(([k, st]) => [k, seal(st)]));
    this.current = seal(configured.current);
  }
  async get(ws: string, id: string): Promise<Asset | undefined> {
    return await this.repo.getMediaAsset(ws, id) as Asset | undefined;
  }
  async authorized(ws: string, id: string, user: string): Promise<Asset> {
    const asset = await this.get(ws, id);
    if (!asset || (asset.owner_user_id !== user && asset.visibility !== 'team'))
      throw new MediaError('asset_not_found', 404);
    return asset;
  }
  async upload(ws: string, user: string, name: string, mime: string, bytes: Buffer): Promise<Asset> {
    if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new MediaError('file_too_large', 413);
    name = name.slice(0, 255);
    const sha = createHash('sha256').update(bytes).digest('hex');
    // Owner-scoped: identical bytes must not accidentally grant another user access.
    const existing = await this.repo.findMediaAssetByContent(ws, user, sha, name) as Asset | undefined;
    if (existing) return existing;
    // Concurrent redeliveries must converge before provider work, not merely
    // deduplicate after both uploads have already produced different asset IDs.
    const id = `asset_${createHash('sha256')
      .update(JSON.stringify([ws, user, sha, name]))
      .digest('hex')
      .slice(0, 32)}`;
    const retiring = await this.repo.getMediaAssetDeleting(ws, id) as { deleting: number } | undefined;
    if (retiring?.deleting) throw new MediaError('asset_expiring', 409);
    const asset: Asset = {
      workspace_id: ws,
      id,
      object_key: `${ws}/assets/${id}/original`,
      backend: this.current.backend,
      original_name: name.slice(0, 255),
      mime,
      bytes: bytes.length,
      sha256: sha,
      owner_user_id: user,
      visibility: 'private',
      created_at: new Date().toISOString(),
    };
    await this.current.put(asset.object_key, bytes, mime);
    try {
      await this.repo.insertMediaAsset(asset);
    } catch (error) {
      if (!await this.get(ws, id)) await this.current.delete(asset.object_key);
      throw error;
    }
    return (await this.get(ws, id))!;
  }
  async read(asset: Asset): Promise<Buffer> {
    const store = this.stores[asset.backend];
    if (!store) throw new MediaError('asset_backend_not_configured', 503);
    return store.read(asset.object_key);
  }
  async binding(ws: string, target: string, capability: string): Promise<ReaderConfig | null> {
    const row = await this.repo.getMediaBindingConfig(ws, target, capability) as { config: string; enabled: number } | undefined;
    return row?.enabled ? ReaderConfig.parse(JSON.parse(row.config)) : null;
  }
  async process(asset: Asset, config: ReaderConfig): Promise<{ run_id: string; result: MediaResult }> {
    await this.authorized(asset.workspace_id, asset.id, asset.owner_user_id);
    const processor = processorConfig(asset.mime, config);
    const serialized = JSON.stringify(processor);
    const id = `media_${createHash('sha256')
      .update(asset.id + serialized)
      .digest('hex')
      .slice(0, 32)}`;
    const ws = asset.workspace_id;
    const now = new Date().toISOString();
    await this.repo.insertMediaRun(ws, id, asset.id, serialized, now, now);
    const row = await this.repo.getMediaRunResult(ws, id) as { status: string; result: string | null };
    if (row.status === 'succeeded' && row.result) return { run_id: id, result: JSON.parse(row.result) };
    const active = await this.repo.countActiveMediaRuns(ws, Date.now()) as { n: number };
    if (active.n >= 2) throw new MediaError('media_capacity', 409);
    const claimed = await this.repo.claimMediaRun(Date.now() + 15 * 60_000, now, ws, id, Date.now());
    if (!claimed.changes) throw new MediaError('media_processing', 409);
    try {
      const result = await this.reader(asset, await this.read(asset), processor);
      await this.repo.completeMediaRun(JSON.stringify(result), new Date().toISOString(), ws, id);
      return { run_id: id, result };
    } catch (error) {
      await this.repo.failMediaRun(new Date().toISOString(), ws, id);
      throw error;
    }
  }
  /** The latest successful transcript or image reading, or the named run when supplied. */
  async runText(ws: string, asset_id: string, run_id?: string): Promise<{ text: string; run_id: string } | null> {
    const row = await this.repo.getSucceededMediaRunText(ws, asset_id, run_id);
    if (!row) return null;
    try {
      const result = JSON.parse(row.result) as MediaResult;
      const text = (result.text ?? result.ocr ?? '').trim();
      return text ? { text, run_id: row.id } : null;
    } catch {
      return null;
    }
  }
  async link(ws: string, document: string, version: number, provenance: MediaProvenance[], user: string): Promise<void> {
    for (const source of provenance) {
      if (source.workspace_id !== ws) throw new MediaError('asset_workspace_mismatch', 403);
      await this.authorized(ws, source.asset_id, user);
      const run_id = source.run_id ?? (await this.runText(ws, source.asset_id))?.run_id ?? null;
      await this.repo.linkDocumentAsset(ws, document, version, source.asset_id, run_id);
    }
  }
  async nodeAssets(ws: string, node: string, user: string): Promise<Asset[]> {
    // Node and source permissions are independent. An inaccessible node must not reveal its attachments.
    const visible = await this.repo.getNodeVisibleToUser(ws, node, user);
    if (!visible) return [];
    return await this.repo.listNodeMediaAssets(ws, user, node) as Asset[];
  }
  async documentAssets(ws: string, document: string, user: string): Promise<Asset[]> {
    if (!await this.repo.getDocument(ws, document)) return [];
    return await this.repo.listDocumentMediaAssets(ws, user, document) as Asset[];
  }
  async deleteWorkspace(ws: string): Promise<void> {
    // Fail before dropping DB references on storage failure; retrying DELETE is safe.
    const assets = await this.repo.listWorkspaceMediaAssets(ws) as Asset[];
    for (const asset of assets) {
      const store = this.stores[asset.backend];
      if (!store) throw new MediaError('asset_backend_not_configured', 503);
      await store.delete(asset.object_key);
    }
  }

  async createIngest(asset: Asset, input: MediaIngestInput): Promise<string> {
    await this.authorized(asset.workspace_id, asset.id, asset.owner_user_id);
    const payload = JSON.stringify(input);
    const id = `mjob_${createHash('sha256')
      .update(asset.id + payload)
      .digest('hex')
      .slice(0, 32)}`;
    const now = new Date().toISOString();
    await this.repo.insertMediaIngestJob(asset.workspace_id, id, asset.id, asset.owner_user_id, payload, now, now);
    return id;
  }

  async runIngest(ws: string, id: string, user: string): Promise<Record<string, unknown>> {
    const job = await this.repo.getMediaIngestJob(ws, id, user) as IngestJob | undefined;
    if (!job) throw new MediaError('job_not_found', 404);
    if (job.receipt) return JSON.parse(job.receipt);
    const input = JSON.parse(job.payload) as MediaIngestInput;
    // Recheck permissions and destination on retries; a queued job is not an enduring grant.
    if (!(await this.canIngest(ws, user)) || (await this.repo.getSubgraph(ws, input.subgraph_id))?.status !== 'active') {
      await this.repo.failMediaIngestJobDestination(ws, id);
      throw new MediaError('destination_unavailable', 403);
    }
    if (!this.ingest) throw new MediaError('media_ingest_unavailable', 503);
    const asset = await this.authorized(ws, job.asset_id, user);
    const claimed = await this.repo.claimMediaIngestJob(Date.now() + 15 * 60_000, new Date().toISOString(), ws, id, Date.now());
    if (!claimed.changes) throw new MediaError('media_processing', 409);
    try {
      const receipt = await withLlmContext(
        { workspace_id: ws, user_id: user, caller: 'data_agent.media_job' },
        async () => {
          const processed = await this.process(asset, input.config);
          return {
            ...(await this.ingest!(asset, input, processed)),
            job_id: id,
            asset_id: asset.id,
            run_id: processed.run_id,
          };
        },
      );
      await this.repo.completeMediaIngestJob(JSON.stringify(receipt), new Date().toISOString(), ws, id);
      return receipt;
    } catch (error) {
      await this.repo.failMediaIngestJob(error instanceof MediaError || error instanceof RedactionUnavailableError ? error.code : 'media_processing_failed', Date.now() + 60_000, new Date().toISOString(), ws, id);
      throw error;
    }
  }

  async runDue(): Promise<void> {
    const jobs = await this.repo.listDueMediaIngestJobs(Date.now(), Date.now()) as Array<{ workspace_id: string; id: string; user_id: string }>;
    for (const job of jobs) {
      try {
        await this.runIngest(job.workspace_id, job.id, job.user_id);
      } catch {
        /* Persisted for the owner to inspect/retry. */
      }
    }
    await this.cleanupUnfiled();
  }

  async cleanupUnfiled(): Promise<void> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const assets = await this.repo.listUnfiledMediaAssets(cutoff, Date.now(), Date.now()) as Asset[];
    for (const asset of assets) {
      try {
        const store = this.stores[asset.backend];
        if (!store) continue;
        // Reserve deletion synchronously before awaiting storage. New jobs/links
        // can no longer acquire this asset while the object is being removed.
        const claimed = await this.repo.reserveMediaAssetDeletion(asset.workspace_id, asset.id, Date.now(), Date.now());
        if (!claimed.changes) continue;
        await store.delete(asset.object_key);
        await this.repo.deleteMediaAsset(asset.workspace_id, asset.id);
      } catch {
        /* Keep the row so the next sweep can retry deletion. */
      }
    }
  }
}

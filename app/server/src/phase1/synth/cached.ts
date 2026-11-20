import { createHash } from 'node:crypto';
import { Repo } from '../db/repo.js';
import type { SynthesisProvider } from '../../lib/synthesis.js';
import type {
  Candidate,
  CandidateGroup,
  ContextProfile,
  DocTriageDossier,
  DocTriagePayload,
  DocTriageSlimCandidate,
  Finding,
  GraphEdge,
  Node,
  UsageAnalysisInput,
} from '../../lib/schemas.js';

/**
 * Workspace-scoped, graph-hash-keyed cache around the synthesis provider.
 * Cache key: {ws}:{task}:{profile_hash}:{graph_hash}:{request_hash} (spec B5).
 *
 * Graph hash invalidates on any active-node mutation; the profile hash
 * invalidates cleanly on a profile edit. Cache key always includes
 * workspace_id to prevent cross-tenant collisions (PRD integrity).
 */
export class CachedSynth implements SynthesisProvider {
  readonly name: string;
  private readonly profileHash: string;
  constructor(
    private readonly underlying: SynthesisProvider,
    private readonly repo: Repo,
    private readonly workspace_id: string,
    private readonly ttlSec = 900,
    private readonly profile?: ContextProfile,
  ) {
    this.name = `cached(${underlying.name})`;
    // A stable, content-addressed hash of the profile so a profile edit
    // invalidates this workspace's cached synthesis cleanly. Empty-string
    // sentinel when no profile is supplied keeps legacy callers' keys stable.
    this.profileHash = profile
      ? sha256(JSON.stringify(profile)).slice(0, 16)
      : 'none';
  }

  triage(prompt: string, response: string) {
    // Triage is per-interaction and not graph-dependent — no cache.
    return this.underlying.triage(prompt, response);
  }

  async capture(opts: {
    graph: readonly Node[];
    sourceKind: 'doc' | 'slack' | 'transcript' | 'interaction';
    source: string;
    profile?: ContextProfile;
    trace?: Array<{ stage: string; [k: string]: unknown }>;
    sourceRef?: string;
  }): Promise<Candidate[]> {
    const key = this.makeKey('capture', { sourceKind: opts.sourceKind, source: opts.source }, opts.graph);
    const cached = await this.repo.cacheGet(key) as Candidate[] | undefined;
    if (cached) return cached;
    const value = await this.underlying.capture({ profile: this.profile, ...opts });
    await this.repo.cacheSet({ cache_key: key, workspace_id: this.workspace_id, value, ttlSec: this.ttlSec });
    return value;
  }

  async feedback(opts: {
    graph: readonly Node[];
    /** Folded into the request hash — see `query` below. */
    edges?: readonly GraphEdge[];
    kind?: string;
    deliverable: string;
    profile?: ContextProfile;
  }): Promise<Finding[]> {
    const request: Record<string, unknown> = { kind: opts.kind ?? 'other', deliverable: opts.deliverable };
    if (opts.edges && opts.edges.length > 0) request.edges = edgeCacheFingerprint(opts.edges);
    const key = this.makeKey('feedback', request, opts.graph);
    const cached = await this.repo.cacheGet(key) as Finding[] | undefined;
    if (cached) return cached;
    const value = await this.underlying.feedback({ profile: this.profile, ...opts });
    await this.repo.cacheSet({ cache_key: key, workspace_id: this.workspace_id, value, ttlSec: this.ttlSec });
    return value;
  }

  async query(opts: {
    graph: readonly Node[];
    /**
     * Folded into the request hash, NOT the graph hash: an edge write doesn't
     * touch node content, so without this an edge change would leave a stale
     * pre-change answer cached and indistinguishable from a fresh one.
     */
    edges?: readonly GraphEdge[];
    scope: string;
    question: string;
    profile?: ContextProfile;
    sourceExcerpts?: ReadonlyArray<{ chunk_id: string; source_ref: string; text: string }>;
  }): Promise<{
    answer: string;
    cited_node_ids: string[];
    has_answer: boolean;
    cited_chunk_ids?: string[];
    answered_from?: 'canon' | 'source' | 'both' | 'none';
  }> {
    // Fold the retrieved excerpt ids into the request hash so a change in what
    // sources say (new source ingested that produced no node → graph unchanged)
    // still invalidates the cached answer. Omitted when there are no excerpts,
    // keeping the node-only cache key byte-identical to before.
    const excerpts = opts.sourceExcerpts ?? [];
    const request: Record<string, unknown> = { scope: opts.scope, question: opts.question };
    if (excerpts.length > 0) request.excerpts = excerpts.map((e) => e.chunk_id).sort();
    if (opts.edges && opts.edges.length > 0) request.edges = edgeCacheFingerprint(opts.edges);
    const key = this.makeKey('query', request, opts.graph);
    const cached = await this.repo.cacheGet(key) as
      | {
          answer: string;
          cited_node_ids: string[];
          has_answer: boolean;
          cited_chunk_ids?: string[];
          answered_from?: 'canon' | 'source' | 'both' | 'none';
        }
      | undefined;
    if (cached) return cached;
    const value = await this.underlying.query({ profile: this.profile, ...opts });
    await this.repo.cacheSet({ cache_key: key, workspace_id: this.workspace_id, value, ttlSec: this.ttlSec });
    return value;
  }

  async overview(opts: {
    graph: readonly Node[];
    profile?: ContextProfile;
  }): Promise<{ summary: string }> {
    // No request params — the overview is a pure function of the graph
    // (+ profile, already in the key). Any active-node mutation re-keys it.
    const key = this.makeKey('overview', {}, opts.graph);
    const cached = await this.repo.cacheGet(key) as { summary: string } | undefined;
    if (cached) return cached;
    const value = await this.underlying.overview({ profile: this.profile, ...opts });
    await this.repo.cacheSet({ cache_key: key, workspace_id: this.workspace_id, value, ttlSec: this.ttlSec });
    return value;
  }

  workAgent(opts: {
    agent: 'draft' | 'synthesize' | 'catchup' | 'followup';
    graph: readonly Node[];
    input: string;
    docType?: string;
    profile?: ContextProfile;
  }): Promise<{ title: string; output: string; cited_node_ids: string[] }> {
    // Not cached: the input is free text and the artifact is a one-shot piece of
    // work the user will edit — a cache layer would only serve staleness. Same
    // stance as triage/docTriage.
    return this.underlying.workAgent({ profile: this.profile, ...opts });
  }

  async usageAnalysis(opts: {
    usage: UsageAnalysisInput;
    profile?: ContextProfile;
  }): Promise<{ summary: string }> {
    // Keyed by the usage input itself (not the graph) — identical usage state
    // within the TTL is a free cache hit; any new request re-keys it.
    const key = `${this.workspace_id}:usage_analysis:${this.profileHash}:${sha256(JSON.stringify(opts.usage)).slice(0, 16)}`;
    const cached = await this.repo.cacheGet(key) as { summary: string } | undefined;
    if (cached) return cached;
    const value = await this.underlying.usageAnalysis({ profile: this.profile, ...opts });
    await this.repo.cacheSet({ cache_key: key, workspace_id: this.workspace_id, value, ttlSec: this.ttlSec });
    return value;
  }

  async groupCandidates(opts: {
    candidates: ReadonlyArray<{
      id: string;
      flag: 'red' | 'yellow' | 'green';
      type: string;
      kind?: string;
      category?: string;
      priority?: string;
      summary: string;
      source_ref: string;
    }>;
    profile?: ContextProfile;
  }): Promise<CandidateGroup[]> {
    // Cache key includes only the candidate-id set (sorted) — a leader who
    // refreshes the Curate inbox without ingesting anything new sees the
    // same groups for free. Graph state is irrelevant to grouping.
    const sortedIds = [...opts.candidates].map((c) => c.id).sort();
    const key = `${this.workspace_id}:groups:${sha256(JSON.stringify(sortedIds)).slice(0, 16)}`;
    const cached = await this.repo.cacheGet(key) as CandidateGroup[] | undefined;
    if (cached) return cached;
    const value = await this.underlying.groupCandidates({ profile: this.profile, ...opts });
    await this.repo.cacheSet({ cache_key: key, workspace_id: this.workspace_id, value, ttlSec: this.ttlSec });
    return value;
  }

  docTriage(opts: {
    dossier: DocTriageDossier;
    candidates: ReadonlyArray<DocTriageSlimCandidate>;
    profile: ContextProfile;
  }): Promise<DocTriagePayload> {
    // No synth-cache layer: doc-triage results are persisted durably in the
    // doc_triage table keyed by (document, pending-set signature) — a second
    // cache here would only add a stale layer in front of the durable one.
    return this.underlying.docTriage(opts);
  }

  private makeKey(task: string, request: Record<string, unknown>, graph: readonly Node[]): string {
    const graphHash = sha256(
      JSON.stringify([...graph].sort((a, b) => a.id.localeCompare(b.id))),
    ).slice(0, 16);
    const requestHash = sha256(JSON.stringify(request)).slice(0, 16);
    return `${this.workspace_id}:${task}:${this.profileHash}:${graphHash}:${requestHash}`;
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** A stable, order-independent fingerprint of an edge set for cache-key folding. */
function edgeCacheFingerprint(edges: readonly GraphEdge[]): string[] {
  return [...edges].map((e) => `${e.src}>${e.kind}>${e.dst}`).sort();
}

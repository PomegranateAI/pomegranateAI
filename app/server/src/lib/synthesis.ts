/**
 * Synthesis provider — Anthropic, exclusively.
 *
 * Earlier revisions of this file shipped two additional providers (an Ollama
 * adapter for self-hosted models and a heuristic regex stub). Both were
 * removed after the dogfood pass showed:
 *   - CPU inference on small open-weights models was too slow to be usable
 *     for the capture/feedback flows.
 *   - The heuristic stub produced placeholder graph nodes ("Inferred goal",
 *     etc.) that gave the canon zero value.
 *
 * Keeping third-party LLMs out of the data path entirely is a later
 * follow-on; the provider is pluggable (see lib/llm-provider.ts).
 *
 * Tests that need a deterministic stub import `TestSynthStub` from
 * `__test_utils__/synth-stub.ts`.
 */
import {
  runTriage as anthropicTriage,
  runCapture as anthropicCapture,
  runFeedback as anthropicFeedback,
  runQuery as anthropicQuery,
  runOverview as anthropicOverview,
  runWorkAgent as anthropicWorkAgent,
  runUsageAnalysis as anthropicUsageAnalysis,
  runGroupCandidates as anthropicGroupCandidates,
  runDocTriage as anthropicDocTriage,
  runEvaluateRules as anthropicEvaluateRules,
  runRedactFields as anthropicRedactFields,
  runClassifyRule as anthropicClassifyRule,
} from './anthropic.js';
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
  TriageResult,
  UsageAnalysisInput,
} from './schemas.js';

export interface SynthesisProvider {
  name: string;
  // Triage is profile-agnostic (spec B5: "triage unchanged").
  triage(prompt: string, response: string): Promise<TriageResult>;
  capture(opts: {
    graph: readonly Node[];
    sourceKind: 'doc' | 'slack' | 'transcript' | 'interaction';
    source: string;
    /** Workspace context profile. Optional; defaults to FALLBACK_PROFILE (todo_list). */
    profile?: ContextProfile;
    /** Optional routed-pipeline trace collector (route/specialist/merge events). */
    trace?: Array<{ stage: string; [k: string]: unknown }>;
    /** Optional file path / ref for the router's path priors. */
    sourceRef?: string;
    /** Optional store-phase ingestion-rule policy injected into the capture
     * prompt (spec-directory-tracking-and-ingestion-rules.md §5.3b). */
    rulePolicy?: string;
    /** True when `profile` is an attached data agent's template, not the
     * subfolder's baseline (spec-data-agents-and-subfolder-wiki.md §3) —
     * enables the operation_rule slot's supersede teaching. Default false
     * keeps every existing caller's note-path prompt byte-identical. */
    dataAgentActive?: boolean;
  }): Promise<Candidate[]>;
  feedback(opts: {
    graph: readonly Node[];
    // Every edge in the subfolder this profile has declared, if any —
    // retrieval loads everything.
    edges?: readonly GraphEdge[];
    // Profile-driven review kinds (ContextProfile.review_kinds).
    kind?: string;
    deliverable: string;
    profile?: ContextProfile;
  }): Promise<Finding[]>;
  query(opts: {
    graph: readonly Node[];
    edges?: readonly GraphEdge[];
    // Profile-driven scope key (ContextProfile.query_scopes).
    scope: string;
    question: string;
    profile?: ContextProfile;
    // Source-RAG excerpts (spec-source-rag-hybrid-answering.md). Empty/omitted →
    // node-only answering, byte-identical to before.
    sourceExcerpts?: ReadonlyArray<{ chunk_id: string; source_ref: string; text: string }>;
  }): Promise<{
    answer: string;
    cited_node_ids: string[];
    has_answer: boolean;
    cited_chunk_ids?: string[];
    answered_from?: 'canon' | 'source' | 'both' | 'none';
  }>;
  // Short, concrete dashboard description of what the active graph contains.
  // Empty-string summary = graph too thin to say anything specific.
  overview(opts: {
    graph: readonly Node[];
    profile?: ContextProfile;
  }): Promise<{ summary: string }>;
  // Work agent (spec-work-agents.md) — produce a finished artifact from the
  // CALLER'S OWN graph. Own-context-only: the route supplies the caller's own
  // active nodes and never crosses folders. Empty `output` = graph too thin.
  workAgent(opts: {
    agent: 'draft' | 'synthesize' | 'catchup' | 'followup';
    graph: readonly Node[];
    input: string;
    docType?: string;
    profile?: ContextProfile;
  }): Promise<{ title: string; output: string; cited_node_ids: string[] }>;
  // Owner-facing narrative of how the context is being used (anonymized
  // questions in, no attribution out). Empty-string summary = too few
  // requests to narrate.
  usageAnalysis(opts: {
    usage: UsageAnalysisInput;
    profile?: ContextProfile;
  }): Promise<{ summary: string }>;
  groupCandidates(opts: {
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
  }): Promise<CandidateGroup[]>;
  // Context-aware triage: per-document legitimacy/currency assessment +
  // decision-changing questions. Deterministic policy lives in
  // lib/triage-policy.ts; this is only the scoring/asking call.
  docTriage(opts: {
    dossier: DocTriageDossier;
    candidates: ReadonlyArray<DocTriageSlimCandidate>;
    profile: ContextProfile;
  }): Promise<DocTriagePayload>;
  // Optional: evaluate which store-phase curation-automation rules apply to a
  // source (spec §5.3a — auto-approve / auto-reject / surface). Returns the ids
  // of the applicable rules. Absent on a provider → automation is skipped and
  // the machine-derived curation disposition stands.
  evaluateRules?(opts: {
    rules: ReadonlyArray<{ id: string; action: string; instructions: string }>;
    document: { summary: string; source_ref: string; source_kind: string };
    items: ReadonlyArray<{ id: string; flag: string; summary: string }>;
  }): Promise<{ applicable: string[] }>;
  // Optional: redact a node's text fields before it is served to a broader
  // audience, per use-phase rules (spec §5.3c). Absent → no redaction.
  redactFields?(opts: {
    fields: Record<string, string>;
    rules: ReadonlyArray<{ instructions: string }>;
  }): Promise<{ fields: Record<string, string>; changed: boolean }>;
  // Optional: classify a free-text rule's phase(s) and target (spec §5.2),
  // so the UI needn't ask the user. Absent → caller falls back to store/node.
  classifyRule?(opts: { instructions: string }): Promise<{
    phases: ('store' | 'use')[];
    target: 'node' | 'source' | 'both';
  }>;
}

export const AnthropicProvider: SynthesisProvider = {
  name: 'anthropic',
  triage: anthropicTriage,
  capture: anthropicCapture,
  feedback: anthropicFeedback,
  query: anthropicQuery,
  overview: anthropicOverview,
  workAgent: anthropicWorkAgent,
  usageAnalysis: anthropicUsageAnalysis,
  groupCandidates: anthropicGroupCandidates,
  docTriage: anthropicDocTriage,
  evaluateRules: anthropicEvaluateRules,
  redactFields: anthropicRedactFields,
  classifyRule: anthropicClassifyRule,
};

export function getProvider(): SynthesisProvider {
  return AnthropicProvider;
}

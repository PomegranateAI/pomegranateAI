import { z } from 'zod';

export const Flag = z.enum(['red', 'yellow', 'green']);
export type Flag = z.infer<typeof Flag>;

export const NodeType = z.enum(['goal', 'positioning', 'decision']);
export type NodeType = z.infer<typeof NodeType>;

export const NodeStatus = z.enum(['active', 'archived']);
export type NodeStatus = z.infer<typeof NodeStatus>;

// Helper: treat null and undefined identically for optional model output.
const optStr = () =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => (v === null ? undefined : v))
    .optional();

const NodeBase = z.object({
  id: z.string(),
  // The envelope `type` carries the profile KIND KEY. For the founding
  // profile these are exactly the legacy values ('goal' | 'positioning' |
  // 'decision'); the discriminated-union variants below pin those three so
  // existing rows parse byte-for-byte. Profile-driven kinds beyond founding
  // are parsed via `ProfileNode` (generalized envelope) at the API boundary.
  type: NodeType,
  created_at: z.string(),
  updated_at: z.string(),
  status: NodeStatus.default('active'),
  source: optStr(),
  superseded: optStr(),
  // Generalized envelope extras (spec B1). Optional + additive so legacy
  // goal/positioning/decision rows that never carried them still parse
  // identically. Migration reshapes positioning.kind→subkind,
  // decision.category→category, goal.{priority,period,metric}→attrs.
  subkind: optStr(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Backward-compatible parse (spec B1 / B4): the profile migration reshapes a
 * node's legacy top-level kind fields onto the generalized envelope
 * (positioning.kind→subkind, goal.{priority,period,metric}→attrs.*,
 * decision.{decided_on,decided_by}→attrs.*). To keep `Node.parse` — and the
 * API responses it feeds — byte-identical before and after migration, this
 * preprocessor reconstitutes the legacy top-level fields from the generalized
 * envelope when they're absent. Non-reshaped (pre-migration) nodes already
 * carry the legacy fields, so the backfill is a no-op for them.
 */
function backfillLegacyFields(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const n = { ...(raw as Record<string, unknown>) };
  const attrs = n.attrs && typeof n.attrs === 'object' && !Array.isArray(n.attrs)
    ? (n.attrs as Record<string, unknown>)
    : undefined;
  if (n.type === 'positioning') {
    if (n.kind === undefined && n.subkind !== undefined) n.kind = n.subkind;
  } else if (n.type === 'goal') {
    if (attrs) {
      if (n.priority === undefined && attrs.priority !== undefined) n.priority = attrs.priority;
      if (n.period === undefined && attrs.period !== undefined) n.period = attrs.period;
      if (n.metric === undefined && attrs.metric !== undefined) n.metric = attrs.metric;
    }
  } else if (n.type === 'decision') {
    if (attrs) {
      if (n.decided_on === undefined && attrs.decided_on !== undefined) n.decided_on = attrs.decided_on;
      if (n.decided_by === undefined && attrs.decided_by !== undefined) n.decided_by = attrs.decided_by;
    }
  }
  return n;
}

export const GoalNode = NodeBase.extend({
  type: z.literal('goal'),
  title: z.string(),
  body: z.string(),
  priority: z.enum(['north_star', 'priority', 'supporting']),
  period: optStr(),
  metric: z
    .object({
      name: z.string(),
      current: optStr(),
      target: optStr(),
    })
    .nullish()
    .transform((v) => v ?? undefined)
    .optional(),
});
export type GoalNode = z.infer<typeof GoalNode>;

export const PositioningKind = z.enum([
  'stance',
  'differentiator',
  'killed_messaging',
  'banned_phrase',
  'approved_phrase',
  'competitive_claim',
]);
export type PositioningKind = z.infer<typeof PositioningKind>;

export const PositioningNode = NodeBase.extend({
  type: z.literal('positioning'),
  body: z.string(),
  kind: PositioningKind,
});
export type PositioningNode = z.infer<typeof PositioningNode>;

export const DecisionCategory = z.enum([
  'pricing',
  'positioning',
  'scope',
  'hiring',
  'strategy',
  'other',
]);
export type DecisionCategory = z.infer<typeof DecisionCategory>;

// Coerce null/missing to "unknown" so the candidate still flows through;
// the leader can edit the date on approval.
const requiredStr = (fallback: string) =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => (v == null || v === '' ? fallback : v));

export const DecisionNode = NodeBase.extend({
  type: z.literal('decision'),
  summary: z.string(),
  body: z.string(),
  decided_on: requiredStr('unknown'),
  decided_by: optStr(),
  category: DecisionCategory,
});
export type DecisionNode = z.infer<typeof DecisionNode>;

export const Node = z.preprocess(
  backfillLegacyFields,
  z.discriminatedUnion('type', [GoalNode, PositioningNode, DecisionNode]),
);
export type Node = z.infer<typeof Node>;

/**
 * Generalized node envelope (spec B1) for profile-driven kinds beyond the
 * founding three. `type` is any profile kind key; kind-specific extras live
 * in `{ subkind?, category?, attrs? }`. This is used when a workspace runs a
 * non-founding profile whose kinds aren't members of the legacy union.
 *
 * `ProfileNode` is a permissive superset: it parses the legacy shapes too
 * (their top-level fields pass through as additional keys). Validation that a
 * node's kind/subkind/category is *allowed* is done against the workspace
 * ContextProfile at write time, not here.
 */
export const ProfileNode = z
  .object({
    id: z.string(),
    type: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    status: NodeStatus.default('active'),
    source: optStr(),
    body: z.string(),
    title: optStr(),
    subkind: optStr(),
    category: optStr(),
    attrs: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ProfileNode = z.infer<typeof ProfileNode>;

export const Candidate = z.object({
  id: z.string(),
  proposed_node: Node,
  flag: Flag,
  source_quote: z.string(),
  source_ref: z.string(),
  confidence: z.number().min(0).max(1),
  conflicts_with: optStr(),
  reason: optStr(),
});
export type Candidate = z.infer<typeof Candidate>;

/**
 * Profile-driven candidate (spec Part B): identical to `Candidate` except the
 * `proposed_node` is parsed with the generalized `ProfileNode` envelope rather
 * than the strict founding `Node` union. A workspace running a non-founding
 * profile (marketing, product, custom) emits profile-specific kinds (voice,
 * audience, channel, campaign_decision, principle, user_insight,
 * scope_boundary, …) which are NOT members of the legacy `goal | positioning |
 * decision` union. Parsing those with `Node` fails the discriminator and the
 * candidate is silently dropped in `runCapture`'s per-chunk try/catch — the
 * root cause of the capture-precision regression on profile workspaces.
 *
 * `ProfileNode` is a permissive superset that also parses the founding shapes,
 * so the only behavioural difference is that non-founding kinds now survive.
 * Kind/subkind/category *validity* is enforced downstream against the
 * workspace ContextProfile at write time, mirroring `Finding.category`.
 */
export const ProfileCandidate = z.object({
  id: z.string(),
  proposed_node: ProfileNode,
  flag: Flag,
  source_quote: z.string(),
  source_ref: z.string(),
  confidence: z.number().min(0).max(1),
  conflicts_with: optStr(),
  reason: optStr(),
  /**
   * Restored for the data-agent capture path (spec-data-agents-and-
   * subfolder-wiki.md §2, §3.1) — removed 2026-07-31 (PR #145) when the
   * only live profile was log-shaped and every candidate was structurally
   * an addition. `capture.md`'s shared body still asserts "no operation to
   * choose" for that path unconditionally; these fields are populated only
   * when the agent-path `{{operation_rule}}` slot is in play, and the
   * write path (routes.ts) applies the resulting supersede pointer ONLY
   * for an active data agent's candidates — a note-path candidate that
   * somehow carries `change`/`nuance` is written as a plain addition,
   * never interpreted as a supersede. Default 'addition' keeps every
   * existing caller (which never sets this) behaving byte-identically.
   */
  operation: z.enum(['addition', 'change', 'nuance']).default('addition'),
  /** The id of the entry this amends. Required when `operation` is 'change'
   *  or 'nuance'; ignored otherwise. See `operation` above. */
  amends: optStr(),
});
export type ProfileCandidate = z.infer<typeof ProfileCandidate>;

export const FeedbackCategory = z.enum([
  'decisions',
  'goals_priorities',
  'positioning',
  'brand_voice',
  'context_recency',
]);
export type FeedbackCategory = z.infer<typeof FeedbackCategory>;

export const Finding = z.object({
  // Founding categories are the FeedbackCategory enum; profile-driven
  // workspaces use their own feedback-dimension keys, so the stored shape is a
  // free string validated against the workspace profile at write time.
  category: z.string(),
  flag: Flag,
  node_id: z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => (v === undefined ? null : v)),
  quote_from_deliverable: z.string(),
  summary: z.string(),
  source_link: optStr(),
});
export type Finding = z.infer<typeof Finding>;

export const TriageResult = z.object({
  relevant: z.boolean(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});
export type TriageResult = z.infer<typeof TriageResult>;

export const Review = z.object({
  id: z.string(),
  created_at: z.string(),
  prompt: z.string(),
  response: z.string(),
  working_directory: z.string().optional(),
  triage: TriageResult,
  findings: z.array(Finding),
});
export type Review = z.infer<typeof Review>;

export const CapturePayload = z.object({
  candidates: z.array(Candidate),
});

/**
 * Profile-aware capture payload (spec Part B). Used in place of `CapturePayload`
 * when a non-founding profile is active so profile-specific node kinds survive
 * the parse. See `ProfileCandidate`.
 */
export const ProfileCapturePayload = z.object({
  candidates: z.array(ProfileCandidate),
});

export const FeedbackPayload = z.object({
  findings: z.array(Finding),
});

export const QueryPayload = z.object({
  answer: z.string(),
  cited_node_ids: z.array(z.string()),
  has_answer: z.boolean(),
});
export type QueryPayload = z.infer<typeof QueryPayload>;

// Always-hybrid answering (spec-source-rag-hybrid-answering.md §2.4): the query
// payload extended with source-excerpt citations and a provenance marker. Only
// emitted on the hybrid path (source excerpts present); the node-only path keeps
// the QueryPayload shape byte-for-byte. `cited_chunk_ids` and `answered_from`
// default so a model that omits them still parses.
export const QueryHybridPayload = z.object({
  answer: z.string(),
  cited_node_ids: z.array(z.string()),
  cited_chunk_ids: z.array(z.string()).default([]),
  has_answer: z.boolean(),
  answered_from: z.enum(['canon', 'source', 'both', 'none']).default('none'),
});
export type QueryHybridPayload = z.infer<typeof QueryHybridPayload>;

// Work-agent artifact — a finished piece of work produced from the CALLER'S OWN
// graph (prompts/work-agent.md; spec-work-agents.md). Empty `output` = graph too
// thin to do the job; same degrade-don't-fail stance as OverviewPayload.
export const WorkAgentPayload = z.object({
  title: z.string(),
  output: z.string(),
  cited_node_ids: z.array(z.string()).default([]),
});
export type WorkAgentPayload = z.infer<typeof WorkAgentPayload>;

// Dashboard library overview — a short synthesis of what the active graph
// actually contains (prompts/overview.md). Empty string = graph too thin.
// No max() here: the prompt enforces brevity and runOverview truncates
// defensively — a verbose response should degrade, not parse-fail (same
// lesson as the CandidateGroup summary cap below).
export const OverviewPayload = z.object({
  summary: z.string(),
});
export type OverviewPayload = z.infer<typeof OverviewPayload>;

// Owner-facing usage analysis — a short narrative of HOW the context is being
// used (prompts/usage-analysis.md). Empty string = too few requests to say
// anything. Same degrade-don't-fail stance as OverviewPayload.
export const UsageAnalysisPayload = z.object({
  summary: z.string(),
});
export type UsageAnalysisPayload = z.infer<typeof UsageAnalysisPayload>;

// Input shape for the usage-analysis synthesis. Assembled server-side from
// context_usage_log (aggregate shape) + context_request_texts (anonymized
// questions) + resolved node titles. Deliberately carries NO user identity —
// the synthesis must not be able to attribute even if the prompt failed to
// forbid it.
export interface UsageAnalysisInput {
  /** Whose usage this narrative describes: the owner's own requests ('self')
   *  or everyone else's ('team'). Drives the prompt's voice. */
  audience: 'self' | 'team';
  stats: {
    total: number;
    distinct_users: number;
    by_tool: Record<string, number>;
    by_scope: Record<string, number>;
    by_deliverable_kind: Record<string, number>;
  };
  questions: Array<{
    tool: string;
    scope: string | null;
    text: string;
    has_answer: boolean | null;
  }>;
  cited_topics: Array<{ title: string; count: number }>;
  window_days: number;
}

// ---- Candidate grouping (PRD § Curate UI > grouped inbox) ----

export const GroupRecommendedAction = z.enum([
  'approve_all',
  'review_individually',
  'reject_all',
]);
export type GroupRecommendedAction = z.infer<typeof GroupRecommendedAction>;

export const CandidateGroup = z.object({
  title: z.string().min(1).max(160),
  // Empirically the grouping LLM produces summaries up to ~1200 chars when
  // there are many items; 1500 gives headroom without inviting essay-length
  // text. (Original 800 cap was an arbitrary guess that started rejecting
  // grouping responses once candidate sets crossed ~40 items.)
  summary: z.string().min(1).max(1500),
  candidate_ids: z.array(z.string()).min(1),
  recommended_action: GroupRecommendedAction,
  rationale: z.string().min(1).max(500),
});
export type CandidateGroup = z.infer<typeof CandidateGroup>;

export const GroupingPayload = z.object({
  groups: z.array(CandidateGroup).min(1),
});
export type GroupingPayload = z.infer<typeof GroupingPayload>;

// ---- Context-aware triage ----

/** Item blast radius — consequence of approving one candidate. */
export const BlastLevel = z.enum(['high', 'medium', 'low']);
export type BlastLevel = z.infer<typeof BlastLevel>;

/**
 * Deterministic effect of one answer to a triage question. Applying an
 * answer re-runs the decision table with these overrides — no second LLM
 * call, no drift. A `disposition` override wins over score overrides
 * (e.g. "this is an older snapshot" → quarantine regardless of scores).
 */
export const TriageAnswerEffect = z.object({
  legitimacy: z.number().min(0).max(1).optional(),
  currency: z.number().min(0).max(1).optional(),
  disposition: z.enum(['commit_doc', 'triage_items', 'quarantine']).optional(),
});
export type TriageAnswerEffect = z.infer<typeof TriageAnswerEffect>;

/**
 * A question the triage assessment may ask the user. Questions must be
 * DECISION-CHANGING: at least one answer's effect alters the disposition.
 * `attest` is yes/no ("This is the current Q3 roadmap"); `clarify` carries
 * options ("Latest status — the graph is behind" / "Older snapshot").
 */
export const TriageQuestion = z.object({
  id: z.string().min(1),
  kind: z.enum(['attest', 'clarify']),
  text: z.string().min(1).max(400),
  /** For clarify; attest renders yes/no. */
  options: z.array(z.string().min(1)).max(6).optional(),
  affects: z.enum(['legitimacy', 'currency', 'scope']),
  /** answer (or 'yes'/'no' for attest) → deterministic effect. */
  resolution: z.record(z.string(), TriageAnswerEffect),
});
export type TriageQuestion = z.infer<typeof TriageQuestion>;

/** Output of the doc-triage assessment LLM call (prompts/doc-triage.md). */
export const DocTriagePayload = z.object({
  legitimacy: z.number().min(0).max(1),
  /** null for point_in_time source types (staleness is not a property they can have). */
  currency: z
    .union([z.number().min(0).max(1), z.null(), z.undefined()])
    .transform((v) => (v === undefined ? null : v)),
  /** What the doc presents itself as, in the profile's source-type vocabulary. */
  doc_kind_claim: z.string().max(200),
  /** User-facing: who wrote/uploaded this and whether that confers authority. */
  stakeholder_assessment: z.string().max(600),
  /** User-facing: why these scores. */
  rationale: z.string().min(1).max(1200),
  questions: z.array(TriageQuestion).max(3).default([]),
});
export type DocTriagePayload = z.infer<typeof DocTriagePayload>;

/**
 * Input to the doc-triage assessment call — the deterministic dossier
 * assembled server-side from data the pipeline already records (spec §4).
 * No document body: capture already read it; triage reasons about context.
 */
export interface DocTriageDossier {
  source_ref: string;
  source_kind: string;
  /** Router-classified profile source-type key; '' = unclassified. */
  source_type: string;
  version: number;
  summary: string;
  stakeholders: string[];
  internal_stakeholders: string[];
  uploaded_at: string;
  candidate_stats: {
    total: number;
    red: number;
    yellow: number;
    green: number;
    mean_confidence: number;
    conflicts: number;
    kinds: Record<string, number>;
  };
  corroboration_count: number;
  /** (red + conflicts) / (total + corroborations), 0 when nothing extracted. */
  contradiction_rate: number;
}

/** Slim candidate descriptor the doc-triage prompt consumes. */
export interface DocTriageSlimCandidate {
  id: string;
  flag: Flag;
  kind: string;
  summary: string;
  confidence: number;
}

/** Per-document review plan disposition (decision table, triage-policy.ts). */
export const Disposition = z.enum([
  'commit_doc',
  'attest_then_commit',
  'clarify',
  'triage_items',
  'quarantine',
]);
export type Disposition = z.infer<typeof Disposition>;

// ---- Context profiles (spec Part B) ----
//
// A workspace's context model is configurable over a fixed core. The
// primitives above (Node envelope, Flag, Candidate, Finding, citation gates,
// workspace isolation) stay fixed; the *taxonomies* (node kinds, feedback
// dimensions, review kinds, query scopes, flag semantics) move into a
// per-workspace ContextProfile. The `founding` built-in profile is
// byte-equivalent to the hardcoded behaviour the core shipped with.
//
// These schemas describe profile DATA only. They do NOT replace the legacy
// `Node` discriminated union above — that union still parses every stored
// node byte-for-byte. The profile drives prompt rendering and write-time
// validation (kind / subkind / category / feedback-category) against the
// workspace's configured taxonomy.

/** A typed extra field on a node kind (e.g. goal.metric, decision.decided_on). */
export const AttrDef = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['string', 'date', 'enum', 'object']).default('string'),
  values: z.array(z.string()).optional(), // for type 'enum'
  description: optStr(),
  /**
   * Set on EVERY node of this kind, even when the source never mentions it —
   * the extractor infers the default rather than omitting the key.
   *
   * Exists because the capture prompt's attr contract is "include only keys
   * the source supports", which is right for evidence-bearing attrs (never
   * invent an amount) and WRONG for lifecycle state: nobody writes "TODO
   * (status: open)", so a status attr is only ever populated when a source
   * happens to state it. Prod (2026-07-15) showed the cost — personal 0/17
   * nodes with a status, marketing 0/184 — which means the graph never
   * records the state a thing STARTS in, so there is nothing to transition
   * FROM when an update arrives, and status-matched Graph buckets are empty.
   *
   * OPTIONAL and opt-in: absent (every existing attr) keeps the previous
   * source-supports-only behaviour byte-for-byte. Only mark an attr required
   * when a sensible default is INFERABLE without inventing evidence — a
   * lifecycle status is; an amount, a date, or an owner is not.
   */
  required: z.boolean().optional(),
});
export type AttrDef = z.infer<typeof AttrDef>;

/** A Graph-view column bucket (e.g. goal priority north_star/priority/supporting). */
export const BucketDef = z.object({
  key: z.string(),
  label: z.string(),
  /** Attr key (or the legacy top-level field) whose value places a node in this bucket. */
  match: z.string(),
});
export type BucketDef = z.infer<typeof BucketDef>;

export const SubkindDef = z.object({
  key: z.string(),
  label: z.string(),
  description: optStr(),
});
export type SubkindDef = z.infer<typeof SubkindDef>;

export const CategoryDef = z.object({
  key: z.string(),
  label: z.string(),
  description: optStr(),
});
export type CategoryDef = z.infer<typeof CategoryDef>;

/**
 * Anchor declaration for the triage blast-radius scorer (spec: context-aware
 * triage §3.1). Nodes of this kind whose `match` field/attr value is in
 * `values` are workspace ANCHORS — maximum blast radius, never committed by
 * any bulk or doc-level action, and conflicts with them are always surfaced
 * individually. `match` resolves exactly like BucketDef.match: 'subkind',
 * 'category', a declared attr key, or a legacy top-level field ('priority').
 * e.g. founding: goal { match: 'priority', values: ['north_star'] };
 * product/program: goal { match: 'subkind', values: ['north_star'] }.
 */
export const AnchorDef = z.object({
  match: z.string(),
  values: z.array(z.string()).min(1),
});
export type AnchorDef = z.infer<typeof AnchorDef>;

/** Triage consequence tier per node kind (spec: context-aware triage §3.1). */
export const ConsequenceTier = z.enum(['high', 'medium', 'low']);
export type ConsequenceTier = z.infer<typeof ConsequenceTier>;

/**
 * Which declared attr, if any, is a kind's lifecycle/progress signal, and
 * which of that attr's values count as "settled" (spec-data-agents-and-
 * subfolder-wiki.md §5.2 — the one genuinely new field that spec adds).
 * Drives the Report's ordering (open/active before settled) — nothing
 * about capture reads it. `attr` MUST name a declared, enum-typed attr on
 * the same kind; `settled_values` MUST be a non-empty subset of that
 * attr's `values` (enforced in profiles/validate.ts, not here — this
 * schema can't see the kind's own `attrs` array to cross-check against).
 */
export const ProgressDef = z.object({
  attr: z.string(),
  settled_values: z.array(z.string()).min(1),
});
export type ProgressDef = z.infer<typeof ProgressDef>;

export const NodeKindDef = z.object({
  key: z.string(), // 'goal', 'campaign', ...
  label: z.string(),
  label_plural: z.string(),
  description: z.string(), // capture-prompt guidance: what belongs here
  color: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
  ]),
  subkinds: z.array(SubkindDef).optional(),
  categories: z.array(CategoryDef).optional(),
  attrs: z.array(AttrDef).optional(),
  buckets: z.array(BucketDef).optional(),
  /**
   * Override for the `body` line of the rendered capture field spec
   * (renderKindFieldSpecs). Absent = the generic
   * `body (string, 1-3 sentences, canonical form per Step 4)` text, right for
   * an `items`/`slots` kind whose node is a single restated claim. WRONG for
   * a kind whose body is a batch — e.g. a `log`-shape kind that packs every
   * item a document reports into one node, one line per item, no cap
   * (renderShapeRule's cardinality rule). Leaving the generic sentence-count
   * text in place for those kinds told the model two contradictory things at
   * once — "batch everything, no cap" and "1-3 sentences" — and it collapsed
   * toward the sentence limit, silently dropping items (caught 2026-07-17 on
   * `todo_list`). Set this on any kind whose body is not "1-3 sentences of
   * canonical prose" rather than patching the shared fallback text — the
   * template that knows its own body shape is the only one that should
   * describe it.
   */
  body_spec: z.string().optional(),
  /**
   * Triage consequence tier. Absent on EVERY kind = the profile has not
   * opted into context-aware triage and the workspace keeps the grouped
   * inbox wholesale. Absent on SOME kinds of a triage-enabled profile
   * (annotation gap) = 'high' fail-safe for those kinds. The triage engine
   * never names a kind — this declaration is the only consequence signal.
   */
  consequence: ConsequenceTier.optional(),
  /** Anchor declaration — see AnchorDef. Only meaningful with `consequence`. */
  anchor: AnchorDef.optional(),
  /** See ProgressDef. Optional — absent is a fully legitimate choice. */
  progress: ProgressDef.optional(),
});
export type NodeKindDef = z.infer<typeof NodeKindDef>;

/** Feedback dimension + prompt guidance. Replaces hardcoded FeedbackCategory. */
export const DimDef = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
});
export type DimDef = z.infer<typeof DimDef>;

/** Query scope: a named slice of the graph by node-kind keys. */
export const ScopeDef = z.object({
  key: z.string(),
  label: z.string(),
  kind_keys: z.union([z.array(z.string()), z.literal('all')]),
});
export type ScopeDef = z.infer<typeof ScopeDef>;

export const FlagSemantics = z.object({
  red: z.string(),
  yellow: z.string(),
  green: z.string(),
});
export type FlagSemantics = z.infer<typeof FlagSemantics>;

/**
 * An extraction group: a named slice of the profile's kinds extracted by a
 * dedicated specialist call. Profiles with many kinds (e.g. product, 15)
 * declare groups so capture runs as a routed multi-call pipeline:
 * route (relevant? which groups?) → one specialist call per routed group
 * (full definitions of ONLY its kinds) → arbiter merge. Profiles without
 * groups keep the original single-call capture path untouched.
 */
export const ExtractionGroup = z.object({
  key: z.string(),
  label: z.string(),
  kind_keys: z.array(z.string()).min(1),
  /** One line for the router: what content signals this group. */
  description: z.string(),
});
export type ExtractionGroup = z.infer<typeof ExtractionGroup>;

/**
 * A source TYPE a profile expects to ingest (PRD, customer interview, team
 * conversation, policy document, …). The router classifies each document
 * against this list (by content + its own summary); the matched type's
 * `extraction_guidance` is injected into every capture call for that
 * document, so e.g. a team conversation is extracted with
 * conversation-specific care (settled convergences are canon, floated
 * options are not, origin is flagged) without changing how formal documents
 * are handled. Optional for backward compat: profiles/snapshots without
 * source_types keep the previous single-prompt behavior byte-for-byte.
 */
export const SourceTypeDef = z.object({
  key: z.string(), // 'team_conversation', 'customer_interview', 'prd', ...
  label: z.string(),
  /** One line for the router: what this source looks like. */
  description: z.string(),
  /** Injected into capture calls for documents classified as this type. Empty = default handling. */
  extraction_guidance: z.string(),
  /**
   * Ingestion channels ('slack' | 'transcript' | 'interaction' | 'doc') that
   * deterministically suggest this type when no router classification is
   * available (single-call profiles, router failure). First matching type wins.
   */
  source_kinds: z.array(z.string()).optional(),
  /**
   * Deterministic group floor: extraction groups that ALWAYS run when a
   * document is classified as this source type, regardless of the router's
   * group selection. The router stays free to ADD groups; it can never
   * silently drop a floored one. Closes the zero-yield failure shape where
   * a correctly-classified customer interview was routed away from the
   * evidence group and every specialist returned empty (Dan-interview
   * incident, 2026-06-04). Only meaningful on profiles that declare
   * extraction_groups; keys must reference declared groups.
   */
  group_floor: z.array(z.string()).optional(),
  /**
   * Context-aware triage (spec §3.2): can a document of this type be
   * committed to the graph AS A UNIT? Artifacts (PRD, roadmap, charter,
   * brand book, policy doc) = true: the document is either accurate and
   * current — commit everything — or it isn't. Records of discussion
   * (conversations, meeting notes, interviews) = false: they are never
   * "accurate as a unit"; their candidates triage item-wise. Default
   * false (fail safe).
   */
  commit_unit: z.boolean().optional(),
  /**
   * Currency semantics for triage. 'decaying': the document claims to
   * describe NOW (roadmap, status report, strategy memo) — currency must be
   * established (attestation / version / dates) and decays. 'point_in_time':
   * the document records an event (interview, conversation) — it is never
   * "out of date"; only its capture date matters and the triage layer asks
   * no currency questions about it. Default 'decaying' (fail safe: forces
   * the currency question rather than skipping it).
   */
  currency: z.enum(['decaying', 'point_in_time']).optional(),
  /**
   * Which node kinds this source type can authoritatively assert. A customer
   * interview is authoritative for evidence kinds but not for decision kinds
   * (a customer reporting "you decided X" is not a decision). Candidates of
   * non-authoritative kinds are excluded from this doc's commit unit and
   * triage item-wise. Absent or 'any' opts out of the constraint.
   */
  authority_kinds: z.union([z.array(z.string()).min(1), z.literal('any')]).optional(),
  /**
   * Injected into the doc-triage assessment call for documents of this type:
   * what legitimacy looks like for this type, what to be suspicious of.
   * Mirrors extraction_guidance. Empty = default handling.
   */
  triage_guidance: z.string().optional(),
});
export type SourceTypeDef = z.infer<typeof SourceTypeDef>;

/**
 * A typed relation between two graph nodes, declared per profile (like node
 * kinds are). `src_kinds`/`dst_kinds` constrain which node kinds may sit at
 * each end; 'any' opts out of the constraint.
 */
export const EdgeKindDef = z.object({
  key: z.string(), // 'supports' | 'about' | ...
  label: z.string(),
  /** Inference-prompt guidance + UI tooltip: when does this edge apply. */
  description: z.string(),
  src_kinds: z.union([z.array(z.string()).min(1), z.literal('any')]),
  dst_kinds: z.union([z.array(z.string()).min(1), z.literal('any')]),
  directed: z.boolean().default(true),
  /**
   * Deterministic scoping guard for membership-style edges (belongs_to).
   * When set, an LLM-proposed edge of this kind is dropped at apply time
   * unless the SRC node carries this attr (nodes without it are
   * program/portfolio-wide and belong to nothing) AND, when the DST node
   * also carries it, the two values match (case-insensitive). Closes the
   * over-connection failure shape that prompt guidance alone could not:
   * co-occurrence attachment and program-wide leakage.
   */
  scope_attr: z.string().optional(),
  /**
   * Deterministic temporal guard for dependency-style edges. When set, an
   * LLM-proposed edge of this kind is dropped at apply time if BOTH ends
   * carry this date attr and the SRC's date is strictly earlier than the
   * DST's — a dependent cannot be due before its prerequisite. Closes the
   * direction-reversal failure shape on milestone sequencing.
   */
  order_attr: z.string().optional(),
});
export type EdgeKindDef = z.infer<typeof EdgeKindDef>;

/** How an edge entered the graph — kept for audit/filter/removal by origin. */
export const EdgeOrigin = z.enum(['deterministic', 'llm', 'manual', 'migration']);
export type EdgeOrigin = z.infer<typeof EdgeOrigin>;

export const GraphEdge = z.object({
  id: z.string(),
  src: z.string(), // node id
  dst: z.string(), // node id
  kind: z.string(), // EdgeKindDef key, validated against the workspace profile
  status: z.enum(['active', 'archived']).default('active'),
  created_by: EdgeOrigin,
  /** Provenance for llm/manual edges. */
  document_id: optStr(),
  quote: optStr(),
  confidence: z.number().min(0).max(1).optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

export const ContextProfile = z.object({
  id: z.string(), // 'todo_list' | 'project_status' | 'brand_voice' | 'policy_book' | custom id
  name: z.string(),
  description: z.string(), // injected into prompts
  /**
   * Short, discriminative "what feeds this subgraph" blurb used ONLY for
   * multi-subgraph routing — NOT injected into capture prompts. The `description`
   * is a comprehensive extraction charter and overlaps neighbors heavily, which
   * makes one subgraph look sufficient and suppresses fan-out; this field draws
   * the routing boundary instead, naming the SHARED ZONES that must feed two
   * subgraphs at once. OPTIONAL for backward compat (stored snapshots predate it
   * and custom profiles may omit it): routing falls back to `description`.
   */
  routing_hint: z.string().optional(),
  kinds: z.array(NodeKindDef).min(1),
  feedback_dimensions: z.array(DimDef).min(1),
  review_kinds: z.array(z.string()).min(1),
  query_scopes: z.array(ScopeDef).min(1),
  flag_semantics: FlagSemantics,
  seed_questions: z.array(z.string()).default([]),
  extraction_groups: z.array(ExtractionGroup).optional(),
  /**
   * Typed node↔node relations this profile supports. OPTIONAL for
   * backward-compat: stored workspace snapshots predate the field and are
   * re-parsed with this schema (repo.getWorkspaceProfile) — resolve the
   * taxonomy via the builtin profile when the snapshot lacks it.
   */
  edge_kinds: z.array(EdgeKindDef).optional(),
  /**
   * Source types this profile expects to ingest. OPTIONAL for backward
   * compat (stored snapshots predate the field): without it, capture runs
   * with no per-source guidance, exactly as before.
   */
  source_types: z.array(SourceTypeDef).optional(),
  /**
   * Cardinality of the template — the ONE axis the launch templates differ on.
   * Every unit of content is a node either way; `shape` only says how many of
   * them a given heading holds, and therefore what an amendment targets.
   *
   *   'items' — many nodes per kind. A to-do list holds N `task` nodes; the
   *             policy book holds N policies. Seek-amendment matches the ONE
   *             item a document speaks to and supersedes it.
   *   'slots' — exactly one node per named slot. Project status has four slots
   *             (current_state, blockers, recent_decisions, next_milestones);
   *             each holds the node that currently occupies it, carried on the
   *             node's `section` attr. A new node in a slot supersedes the one
   *             it displaces — which is what makes a "narrative section" fall
   *             out of the same storage, the same renderer, and the same
   *             supersede-by-recency rule as an item.
   *   'log'   — one node per KIND present in a document. Each document
   *             contributes at most one node of each kind, batching everything
   *             of that kind into it (six added items → one `new_tasks` node
   *             with six lines). Nodes are dated reports, never amended: the
   *             current state is read by scanning the log newest-first. This is
   *             the to-do list — added / resolved / re-prioritised are three
   *             kinds of report, not three entities. Added 2026-07-17 so the
   *             rendered cardinality rule stops contradicting an event-log
   *             template's kinds (an `items` shape wrongly demanded one node
   *             per item; see renderShapeRule).
   *
   * Replaced `capture_mode` ('claims' | 'whole_doc') on 2026-07-17: both values
   * named stages of a pipeline Light deleted. See
   * the internal design notes
   */
  shape: z.enum(['items', 'slots', 'log']).default('items'),
  /**
   * Asserts that an empty `edge_kinds` is a design choice, not an omission —
   * the validator otherwise treats "no edges" as worth a warning (and blocks
   * on it for builtins). `slots` templates get this for free (relations
   * between fixed headings carry no information); an `items` template needs
   * to say so explicitly, because for most `items` profiles a bare
   * `edge_kinds: []` means someone forgot, not that they decided against it.
   * Set this when the kinds are events/batches with no natural node-to-node
   * relationship to declare (see `todo_list`: `new_tasks`/`status_update`/
   * `priority_change` are reports, not entities — nothing meaningfully
   * "blocks" or "supports" a batch status report).
   */
  edges_deliberately_empty: z.boolean().optional(),
});
export type ContextProfile = z.infer<typeof ContextProfile>;

/**
 * The ingest router's verdict: which folders a document belongs in, plus what
 * the document IS. One pass over the document answers both.
 *
 * Replaced `CaptureRoute` (route-capture) + the bare id list (route-to-subgraphs)
 * on 2026-07-17: the ingest path read the document twice, and neither call could
 * say "no folder". See spec-pomegranate-light.md §4 "Routing ALWAYS runs, and it
 * may drop the document".
 *
 * An EMPTY `target_subgraph_ids` is a valid, expected verdict — the document
 * fits no existing folder. Callers MUST report it, never silently floor it to
 * a default folder — but it is never a silent drop either: an empty verdict
 * always leads to a pending-route asking a human to create a new folder (see
 * `proposeNewFolder` / `resolveIngestTargets`), not to the document being
 * filed nowhere unattended.
 */
export const DocumentRoute = z.object({
  /** Folder ids the document belongs in. Empty = belongs in none of the
   *  EXISTING folders — the caller always follows up by proposing a new one. */
  target_subgraph_ids: z.array(z.string()).default([]),
  /** One sentence: what the document feeds each folder, or why none fit. */
  reason: z.string().default(''),
  /**
   * 2-3 sentence document summary — populates the document registry and rides
   * `attrs.context` on every node captured from this document. Written against
   * the DOCUMENT, not against any one folder's job.
   */
  summary: z.string().default(''),
  /** Authors / participants / named stakeholders in the document. */
  stakeholders: z.array(z.string()).default([]),
});
export type DocumentRoute = z.infer<typeof DocumentRoute>;

/**
 * Output of `proposeNewFolder` — a SEPARATE, single-job call that only runs
 * when `DocumentRoute` named no folder (nothing to route into). Split out of
 * DocumentRoute/route-document.md: bolted onto the routing call, this job
 * consistently lost to the primary "which existing folder" job on a weak
 * model, which ignored it entirely rather than attending to it.
 *
 * Always a real proposal — routing never ends in a silent drop. A document
 * that fits no existing folder always surfaces a pending-route asking a human
 * to create one (or reject it); this call just names that folder. See
 * resolveIngestTargets / runTextIngest in phase1/api/routes.ts.
 */
export const ProposeNewFolder = z.object({
  /** Always requires human approval before the folder is actually created —
   *  never auto-applied. */
  propose_new_folder: z.object({
    name: z.string(),
    description: z.string(),
  }),
  reason: z.string().default(''),
});
export type ProposeNewFolder = z.infer<typeof ProposeNewFolder>;

/** Arbiter verdicts for merging specialist outputs. */
export const MergeVerdicts = z.object({
  verdicts: z.array(
    z.object({
      idx: z.number().int(),
      action: z.enum(['keep', 'drop']),
      reason: z.string().optional().nullable(),
    }),
  ),
});
export type MergeVerdicts = z.infer<typeof MergeVerdicts>;

/**
 * Criteria for a recurring ingestion automation (apps_pull / slack_listen /
 * track_directory kinds of `automations`). `query` is the SAME free-text
 * request the Add Source app-picker already takes — the per-connector planner
 * (planGmailPull, planGithubPull, ...) derives its own count/filter/audience
 * from it server-side, same as a manual pull; this type does not re-expose
 * those as separate user-facing controls the connectors don't actually accept.
 * `github`/`slack`/`jira` mirror the picker's structured overrides
 * (mode/repo/branch/path/channel) exactly as sent to /apps/:app/preview|pull.
 *
 * `recency` is accepted starting Stage 3 (apps_pull manual-run) but not yet
 * ACTED ON — a scheduled run (Stage 4) will fold `since_relative` into `query`
 * as a natural-language clause on the automation's first run, then switch to
 * `anchor_to_watermark` (append "since <automation.watermark>" instead) on
 * every run after, the same append-a-clause mechanism working uniformly
 * across every connector since the planner reads free text regardless.
 */
export interface IngestionCriteria {
  query: string;
  recency?: {
    since_relative?: string;
    anchor_to_watermark?: boolean;
  };
  github?: { repo?: string; branch?: string; path?: string; mode: 'prs' | 'files' };
  slack?: { channel?: string };
  jira?: { mode: 'project' | 'board' | 'ticket'; project?: string; board?: string };
}

/** Media-reader output: OCR is kept distinct from visual interpretation. */
export const ImageReading = z.object({
  ocr: z.string().max(100_000),
  description: z.string().max(20_000),
});

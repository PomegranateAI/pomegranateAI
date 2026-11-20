import type { ContextProfile } from '../schemas.js';

/**
 * Semantic validation for context profiles — the rules that keep a profile's
 * entities WELL-DEFINED beyond what the zod structural schema can express.
 *
 * Two severities, deliberately:
 *
 *  - ERRORS are referential-integrity and ambiguity violations that corrupt
 *    pipeline behavior mechanically: an edge kind pointing at a node kind
 *    that doesn't exist, a kind missing from every extraction group (it
 *    would silently never be extracted by the routed pipeline), two source
 *    types claiming the same ingestion channel (resolution becomes
 *    order-dependent), a group_floor naming a group that doesn't exist (the
 *    floor would silently enforce nothing), an enum attr with no values. A
 *    profile write with errors is REJECTED.
 *
 *  - WARNINGS are quality conventions a custom profile may legitimately opt
 *    out of: no edge taxonomy (the documented "no relations" posture), no
 *    source types (legacy capture behavior), an empty extraction_guidance on
 *    a source type (most formal document types need none), a source type in
 *    a grouped profile with no group_floor (the router alone decides which
 *    specialists run — a mis-route silently zero-yields the document; the
 *    Dan-interview incident, 2026-06-04), no 'all' query scope, thin
 *    descriptions. Warnings are returned to the caller and logged, never
 *    blocking.
 *
 * Built-in profiles are held to the higher bar — zero errors AND zero
 * warnings — by profiles.test.ts and validateBuiltinProfiles().
 *
 * This validator runs at WRITE time (PUT profile, builtin registration). It
 * must never run as a gate on snapshot READS: stored snapshots predate rules
 * added later, and a workspace must never brick on read.
 */

export type ProfileValidation = { errors: string[]; warnings: string[] };

/** Ingestion channels the pipeline actually passes as sourceKind. */
const KNOWN_CHANNELS = new Set(['doc', 'slack', 'transcript', 'interaction']);

/**
 * Legacy top-level node fields that founding-era buckets may `match` on.
 * These predate the attrs envelope (goal.priority) and stay valid forever —
 * stored nodes carry them at the top level.
 */
const LEGACY_BUCKET_FIELDS = new Set(['priority']);

function dup<T>(items: readonly T[], key: (t: T) => string): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) dups.add(k);
    seen.add(k);
  }
  return [...dups];
}

export function validateProfileSemantics(profile: ContextProfile): ProfileValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (m: string) => errors.push(m);
  const warn = (m: string) => warnings.push(m);

  // ---- identity ----
  if (!profile.id.trim()) err('profile.id is empty');
  if (!profile.name.trim()) err('profile.name is empty');
  if (!profile.description.trim()) err('profile.description is empty');
  else if (profile.description.trim().length < 80)
    warn('profile.description is under 80 chars — it is the capture prompt\'s canon definition; thin descriptions produce thin graphs');

  // ---- kinds ----
  const kindKeys = new Set(profile.kinds.map((k) => k.key));
  for (const d of dup(profile.kinds, (k) => k.key)) err(`duplicate kind key '${d}'`);
  for (const k of profile.kinds) {
    const at = `kind '${k.key}'`;
    if (!k.key.trim()) err('a kind has an empty key');
    if (!k.label.trim() || !k.label_plural.trim()) err(`${at}: empty label/label_plural`);
    if (!k.description.trim()) err(`${at}: empty description`);
    else if (k.description.trim().length < 60)
      warn(`${at}: description under 60 chars — capture quality depends on per-kind guidance`);

    for (const d of dup(k.subkinds ?? [], (s) => s.key)) err(`${at}: duplicate subkind '${d}'`);
    for (const d of dup(k.categories ?? [], (c) => c.key)) err(`${at}: duplicate category '${d}'`);
    for (const d of dup(k.attrs ?? [], (a) => a.key)) err(`${at}: duplicate attr '${d}'`);
    for (const d of dup(k.buckets ?? [], (b) => b.key)) err(`${at}: duplicate bucket '${d}'`);

    const attrByKey = new Map((k.attrs ?? []).map((a) => [a.key, a]));
    for (const a of k.attrs ?? []) {
      if (a.type === 'enum' && (!a.values || a.values.length === 0))
        err(`${at}: enum attr '${a.key}' declares no values`);
    }

    const subkindKeys = new Set((k.subkinds ?? []).map((s) => s.key));
    const categoryKeys = new Set((k.categories ?? []).map((c) => c.key));

    // ---- triage anchor (context-aware triage §3.1) ----
    // Same resolution semantics as BucketDef.match: subkind / category / a
    // declared attr / legacy top-level field. An anchor that resolves to
    // nothing silently anchors nothing — the blast scorer would miss every
    // node it was meant to protect, so mis-references are errors.
    if (k.anchor) {
      const aat = `${at} anchor`;
      if (!k.consequence)
        warn(`${aat}: anchor declared without a consequence tier — anchors only matter to the triage scorer`);
      if (k.anchor.match === 'subkind') {
        for (const v of k.anchor.values) {
          if (!subkindKeys.has(v)) err(`${aat}: matches subkind but '${v}' is not a declared subkind`);
        }
      } else if (k.anchor.match === 'category') {
        for (const v of k.anchor.values) {
          if (!categoryKeys.has(v)) err(`${aat}: matches category but '${v}' is not a declared category`);
        }
      } else if (attrByKey.has(k.anchor.match)) {
        const a = attrByKey.get(k.anchor.match)!;
        if (a.type === 'enum' && a.values) {
          for (const v of k.anchor.values) {
            if (!a.values.includes(v))
              err(`${aat}: matches enum attr '${k.anchor.match}' but '${v}' is not one of its values`);
          }
        }
      } else if (!LEGACY_BUCKET_FIELDS.has(k.anchor.match)) {
        err(`${aat}: match '${k.anchor.match}' is not subkind/category/a declared attr — the blast scorer cannot resolve it`);
      }
    }

    // ---- progress (spec-data-agents-and-subfolder-wiki.md §5.2) ----
    // `attr` must name a declared, enum-typed attr on this same kind;
    // `settled_values` must be a non-empty subset of that attr's declared
    // values — the ambiguity §5.2 calls out (a 3-state enum doesn't say
    // which state(s) mean "done" without this). Both are errors, not
    // warnings: an unresolvable progress signal breaks the Report's
    // ordering silently rather than degrading it, which is exactly the
    // "no forced structure" fallback this field is supposed to make safe.
    if (k.progress) {
      const pat = `${at} progress`;
      const a = attrByKey.get(k.progress.attr);
      if (!a) {
        err(`${pat}: '${k.progress.attr}' is not a declared attr on this kind`);
      } else if (a.type !== 'enum') {
        err(`${pat}: attr '${k.progress.attr}' is type '${a.type}', not 'enum' — settled_values has nothing to check against`);
      } else {
        const values = a.values ?? [];
        for (const v of k.progress.settled_values) {
          if (!values.includes(v))
            err(`${pat}: settled_values '${v}' is not one of attr '${k.progress.attr}''s declared values`);
        }
      }
    }

    for (const b of k.buckets ?? []) {
      const bat = `${at} bucket '${b.key}'`;
      if (b.match === 'subkind') {
        if (!subkindKeys.has(b.key)) err(`${bat}: matches subkind but '${b.key}' is not a declared subkind`);
      } else if (b.match === 'category') {
        if (!categoryKeys.has(b.key)) err(`${bat}: matches category but '${b.key}' is not a declared category`);
      } else if (attrByKey.has(b.match)) {
        const a = attrByKey.get(b.match)!;
        if (a.type === 'enum' && a.values && !a.values.includes(b.key))
          err(`${bat}: matches enum attr '${b.match}' but '${b.key}' is not one of its values`);
      } else if (!LEGACY_BUCKET_FIELDS.has(b.match)) {
        warn(`${bat}: match '${b.match}' is not subkind/category/a declared attr — the Graph view cannot place nodes in it`);
      }
    }
  }

  // ---- shape/kind cardinality contradiction ----
  // `shape` and each kind's own description independently assert node
  // cardinality — the field is a bare enum a template author sets once; the
  // kind prose is hand-written English reinforcing the same rule for the
  // model's benefit (every `log`-shape builtin does this: "ONE node ... not
  // six nodes"). Nothing keeps the two in sync. todo_list's `shape` flipped
  // 'log' -> 'items' in an unrelated capture-timeout commit (6a0e4ab,
  // 2026-07-18) and nobody re-rendered the prompt to notice the kinds still
  // said "not six nodes" — the rendered shape_rule for `items` then told the
  // model "one node per item", the opposite instruction in the same call, and
  // a real ingest silently merged a new_tasks item into a status_update node.
  // This check is one-directional and heuristic (verified zero false
  // positives against every builtin as of 2026-07-18): a kind asserting
  // "not/never <N> nodes" is asserting log-style batching, so it is only ever
  // a contradiction paired with `shape: 'items'`. It does not check the
  // reverse (items-style "one node per X" phrasing) — that phrase also shows
  // up negated ("do not hold one node per goal") as *reinforcement* of a log
  // shape, so a regex cannot tell the two apart; that direction still needs a
  // human rendering the prompt (see the pomegranate-template-contract skill).
  const BATCH_CARDINALITY_SIGNAL = /\b(?:not|never)\s+\S+\s+nodes\b/i;
  if (profile.shape === 'items') {
    for (const k of profile.kinds) {
      const text = `${k.description} ${k.body_spec ?? ''}`;
      if (BATCH_CARDINALITY_SIGNAL.test(text)) {
        err(
          `kind '${k.key}': description/body_spec asserts batching cardinality ` +
            `("...not N nodes") but profile.shape is 'items', whose rendered ` +
            `shape_rule says "one node per item" — the opposite instruction in ` +
            `the same prompt. Either the kind text describes 'log' behavior and ` +
            `shape should be 'log', or the kind text is stale.`,
        );
      }
    }
  }

  // ---- triage consequence coverage (context-aware triage §3.1) ----
  // Absent on every kind = profile opted out (legal). Absent on SOME kinds
  // of an annotated profile = those kinds fall back to 'high' (fail safe:
  // never bulk-committed) — usually an annotation gap, so warn.
  const triageEnabled = profile.kinds.some((k) => k.consequence);
  if (triageEnabled) {
    const gaps = profile.kinds.filter((k) => !k.consequence).map((k) => k.key);
    if (gaps.length > 0)
      warn(
        `kinds [${gaps.join(', ')}] have no consequence tier while other kinds do — they default to 'high' (never bulk-committed)`,
      );
  }

  // ---- feedback dimensions / review kinds ----
  for (const d of dup(profile.feedback_dimensions, (x) => x.key)) err(`duplicate feedback dimension '${d}'`);
  for (const d of dup(profile.review_kinds, (x) => x)) err(`duplicate review kind '${d}'`);
  if (profile.review_kinds.some((r) => !r.trim())) err('a review kind is an empty string');

  // ---- query scopes ----
  for (const d of dup(profile.query_scopes, (s) => s.key)) err(`duplicate query scope '${d}'`);
  for (const s of profile.query_scopes) {
    if (s.kind_keys === 'all') continue;
    for (const kk of s.kind_keys) {
      if (!kindKeys.has(kk)) err(`query scope '${s.key}' references unknown kind '${kk}'`);
    }
  }
  if (!profile.query_scopes.some((s) => s.kind_keys === 'all'))
    warn("no query scope covers 'all' kinds — whole-graph questions have no scope to run in");

  // ---- flag semantics ----
  for (const f of ['red', 'yellow', 'green'] as const) {
    if (!profile.flag_semantics[f].trim()) err(`flag_semantics.${f} is empty`);
  }

  // ---- extraction groups (optional; when declared, must cover exactly) ----
  const groups = profile.extraction_groups ?? [];
  if (groups.length > 0) {
    for (const d of dup(groups, (g) => g.key)) err(`duplicate extraction group '${d}'`);
    const coverage = new Map<string, number>();
    for (const g of groups) {
      for (const kk of g.kind_keys) {
        if (!kindKeys.has(kk)) err(`extraction group '${g.key}' references unknown kind '${kk}'`);
        coverage.set(kk, (coverage.get(kk) ?? 0) + 1);
      }
      if (!g.description.trim()) err(`extraction group '${g.key}': empty description (the router needs it)`);
    }
    for (const kk of kindKeys) {
      const n = coverage.get(kk) ?? 0;
      if (n === 0)
        err(`kind '${kk}' is in NO extraction group — the routed pipeline would silently never extract it`);
      else if (n > 1) err(`kind '${kk}' is in ${n} extraction groups — it would be extracted by parallel specialists`);
    }
  }

  // ---- edge kinds (optional; "no edges" is a legal posture) ----
  const edges = profile.edge_kinds ?? [];
  if (edges.length === 0 && !profile.edges_deliberately_empty) {
    warn(
      'no edge_kinds declared — this profile will create no graph relations ' +
        '(set edges_deliberately_empty: true if the kinds are events with no natural relation to declare)',
    );
  } else {
    for (const d of dup(edges, (e) => e.key)) err(`duplicate edge kind '${d}'`);
    for (const e of edges) {
      for (const [end, ks] of [['src', e.src_kinds], ['dst', e.dst_kinds]] as const) {
        if (ks === 'any') continue;
        for (const kk of ks) {
          if (!kindKeys.has(kk)) err(`edge '${e.key}' ${end}_kinds references unknown kind '${kk}'`);
        }
      }
      if (!e.description.trim()) err(`edge '${e.key}': empty description`);
      else if (e.description.trim().length < 20)
        warn(`edge '${e.key}': description under 20 chars — edge inference relies on it for direction and anchoring`);
    }
  }

  // ---- source types (optional; empty guidance per type is fine) ----
  const sources = profile.source_types ?? [];
  if (sources.length === 0) {
    warn('no source_types declared — capture runs with no per-source guidance (conversations get no care rules)');
  } else {
    for (const d of dup(sources, (s) => s.key)) err(`duplicate source type '${d}'`);
    const channelOwner = new Map<string, string>();
    const groupKeys = new Set(groups.map((g) => g.key));
    for (const s of sources) {
      if (!s.description.trim()) err(`source type '${s.key}': empty description (the router classifies by it)`);
      // NOTE: s.extraction_guidance MAY be empty — formal document types
      // often need no special handling. That flexibility is deliberate.
      for (const ch of s.source_kinds ?? []) {
        if (!KNOWN_CHANNELS.has(ch)) err(`source type '${s.key}': unknown ingestion channel '${ch}'`);
        const owner = channelOwner.get(ch);
        if (owner) err(`channel '${ch}' is claimed by both '${owner}' and '${s.key}' — the fallback would be order-dependent`);
        else channelOwner.set(ch, s.key);
      }
      // ---- deterministic group floor ----
      // The floor is the source type's capture GUARANTEE: the groups that
      // always run for this type, however the router votes. Same first-class
      // status as extraction_guidance, same failure mode when wrong: a floor
      // naming a missing group enforces nothing, silently.
      const floor = s.group_floor ?? [];
      if (floor.length > 0) {
        if (groups.length === 0)
          err(`source type '${s.key}': group_floor declared but the profile has no extraction_groups — there is no routed pipeline to floor`);
        for (const d of dup(floor, (k) => k)) err(`source type '${s.key}': duplicate group_floor entry '${d}'`);
        for (const gk of floor) {
          if (groups.length > 0 && !groupKeys.has(gk))
            err(`source type '${s.key}': group_floor references unknown extraction group '${gk}'`);
        }
      } else if (groups.length > 0) {
        warn(
          `source type '${s.key}' declares no group_floor — the router alone decides which specialists run for it; a mis-route silently zero-yields the document`,
        );
      }
      // ---- triage fields (context-aware triage §3.2) ----
      // authority_kinds must reference declared kinds: a key that resolves to
      // nothing silently excludes nothing from the commit unit.
      if (s.authority_kinds && s.authority_kinds !== 'any') {
        for (const kk of s.authority_kinds) {
          if (!kindKeys.has(kk))
            err(`source type '${s.key}': authority_kinds references unknown kind '${kk}'`);
        }
      }
      // Triage fields on a profile with no consequence tiers are dead config:
      // the triage layer only activates when kinds are annotated (§3.4).
      if (!triageEnabled && (s.commit_unit !== undefined || s.currency !== undefined || s.authority_kinds !== undefined || s.triage_guidance !== undefined)) {
        warn(
          `source type '${s.key}' declares triage fields but no kind has a consequence tier — the triage layer stays inactive for this profile`,
        );
      }
    }
    if (!channelOwner.has('slack'))
      warn("no source type covers the 'slack' channel — chat ingested without router classification gets no conversation care");
  }

  // ---- seed questions ----
  if (profile.seed_questions.length === 0)
    warn('no seed_questions — they double as the profile\'s acceptance criteria');

  return { errors, warnings };
}

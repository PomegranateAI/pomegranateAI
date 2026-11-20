/**
 * TestSynthStub — deterministic, regex-driven SynthesisProvider used only by
 * the test suite. NOT a production option.
 *
 * Lifted from the old HeuristicProvider; the rules here are intentionally
 * narrow — enough to drive the test fixtures (banned-phrase detection,
 * killed-messaging conflicts, the specific node ids the e2e tests seed)
 * but explicitly not useful for real document extraction. Real extraction
 * is done by AnthropicProvider in production.
 */
import type { Candidate, CandidateGroup, Finding, Node } from '../lib/schemas.js';
import type { SynthesisProvider } from '../lib/synthesis.js';

function lower(s: string): string {
  return s.toLowerCase();
}

function tokens(s: string): string[] {
  return lower(s)
    .replace(/[^a-z0-9$ ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function wordOverlap(a: string, b: string): number {
  const sa = new Set(tokens(a).filter((w) => w.length > 3));
  const sb = new Set(tokens(b).filter((w) => w.length > 3));
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const w of sa) if (sb.has(w)) common++;
  return common / Math.min(sa.size, sb.size);
}

function extractQuote(text: string, needle: string): string {
  const idx = lower(text).indexOf(lower(needle));
  if (idx === -1) return needle;
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + needle.length + 30);
  return text.slice(start, end);
}

const STRATEGIC_KEYWORDS = [
  'positioning', 'roadmap', 'decision', 'kill', 'killed', 'banned', 'approved phrase',
  'north star', 'okr', 'goal', 'priority', 'wedge', 'enterprise', 'mid-market',
  'campaign', 'pitch', 'positioning', 'sales email', 'brand', 'voice', 'messaging',
  'compete', 'competitor', 'differentiator', 'launch', 'hiring', 'freeze',
];

const TECH_KEYWORDS = [
  'refactor', 'crud', 'orm', 'typescript', 'react', 'usestate', 'useeffect',
  'compile', 'build error', 'stack trace', 'docker', 'dependency', 'npm',
];

export const TestSynthStub: SynthesisProvider = {
  name: 'test-stub',

  async triage(prompt, response) {
    const text = lower(`${prompt} ${response}`);
    const strategic = STRATEGIC_KEYWORDS.some((k) => text.includes(k));
    const tech = TECH_KEYWORDS.some((k) => text.includes(k));
    if (strategic && !tech) return { relevant: true, reason: 'Contains strategic keywords.', confidence: 0.85 };
    if (!strategic && tech) return { relevant: false, reason: 'Looks like technical implementation.', confidence: 0.9 };
    return { relevant: strategic, reason: 'Stub classification.', confidence: 0.6 };
  },

  async capture({ graph, sourceKind, source }) {
    const candidates: Candidate[] = [];
    const ts = new Date().toISOString();
    let nextId = 1;
    const txt = lower(source);

    const killMatch = /\b(kill|killing|discontinu|drop|stop|sunset)\w*\b/.exec(txt);
    if (killMatch) {
      const candidate: Candidate = {
        id: `stub-c${nextId++}`,
        proposed_node: {
          id: `stub-dec-${nextId}`,
          type: 'decision',
          created_at: ts,
          updated_at: ts,
          status: 'active',
          summary: `Inferred decision from source (${sourceKind})`,
          body: source.slice(0, 240),
          decided_on: ts.slice(0, 10),
          category: 'other',
        },
        flag: 'green',
        source_quote: source.slice(0, 120),
        source_ref: sourceKind,
        confidence: 0.7,
      };
      for (const n of graph) {
        if (n.type === 'decision' && wordOverlap(n.body + ' ' + n.summary, source) > 0.25) {
          candidate.flag = 'red';
          candidate.conflicts_with = n.id;
          candidate.reason = `Overlaps with active decision ${n.id}`;
          break;
        }
      }
      candidates.push(candidate);
    }

    if (/\bnorth star\b/.test(txt) || /\bokr\b/.test(txt)) {
      const candidate: Candidate = {
        id: `stub-c${nextId++}`,
        proposed_node: {
          id: `stub-goal-${nextId}`,
          type: 'goal',
          created_at: ts,
          updated_at: ts,
          status: 'active',
          title: 'Inferred goal',
          body: source.slice(0, 240),
          priority: 'priority',
        },
        flag: 'green',
        source_quote: source.slice(0, 120),
        source_ref: sourceKind,
        confidence: 0.6,
      };
      for (const n of graph) {
        if (n.type === 'goal' && n.priority === 'north_star' && wordOverlap(n.title + ' ' + n.body, source) > 0.25) {
          candidate.flag = 'red';
          candidate.conflicts_with = n.id;
          break;
        }
      }
      candidates.push(candidate);
    }

    const bannedAdd = /banned phrase[s]?[^.]*"([^"]+)"/i.exec(source);
    if (bannedAdd) {
      candidates.push({
        id: `stub-c${nextId++}`,
        proposed_node: {
          id: `stub-pos-${nextId}`,
          type: 'positioning',
          created_at: ts,
          updated_at: ts,
          status: 'active',
          body: bannedAdd[1]!,
          kind: 'banned_phrase',
        },
        flag: 'green',
        source_quote: bannedAdd[0],
        source_ref: sourceKind,
        confidence: 0.8,
      });
    }
    return candidates;
  },

  async feedback({ graph, deliverable }) {
    const findings: Finding[] = [];
    const text = lower(deliverable);

    for (const n of graph) {
      if (n.status !== 'active') continue;
      if (n.type === 'positioning') {
        const body = lower(n.body);
        if (n.kind === 'banned_phrase' && body.length > 2 && text.includes(body)) {
          findings.push({
            category: 'brand_voice',
            flag: 'red',
            node_id: n.id,
            quote_from_deliverable: extractQuote(deliverable, body),
            summary: `Uses banned phrase "${n.body}"`,
          });
        }
        if (n.kind === 'killed_messaging') {
          for (const sentence of deliverable.split(/(?<=[.!?])\s+/)) {
            if (sentence.length < 10) continue;
            if (wordOverlap(sentence, n.body) > 0.5) {
              findings.push({
                category: 'positioning',
                flag: 'red',
                node_id: n.id,
                quote_from_deliverable: sentence.trim().slice(0, 200),
                summary: `Returns to killed messaging`,
              });
              break;
            }
          }
        }
        if (n.kind === 'approved_phrase' && body.length > 2 && text.includes(body)) {
          findings.push({
            category: 'brand_voice',
            flag: 'green',
            node_id: n.id,
            quote_from_deliverable: extractQuote(deliverable, body),
            summary: `Uses approved phrase "${n.body}"`,
          });
        }
        if (n.kind === 'stance' && wordOverlap(n.body, deliverable) > 0.3) {
          findings.push({
            category: 'positioning',
            flag: 'green',
            node_id: n.id,
            quote_from_deliverable: deliverable.slice(0, 200),
            summary: 'Aligned with active stance',
          });
        }
      }
      if (n.type === 'decision') {
        if (n.id === 'dec-mobile-2026-04-15' && /\bv1\b/.test(deliverable)) {
          findings.push({
            category: 'decisions',
            flag: 'red',
            node_id: n.id,
            quote_from_deliverable: extractQuote(deliverable, 'v1') ?? 'v1',
            summary: 'References the retired v1 app',
          });
        }
        if (n.id === 'dec-hiring-2026-04-30' && /\b(hiring|hire|opening|recruit)\b/.test(text) && /(g\&a|finance|ops|it)/.test(text)) {
          findings.push({
            category: 'decisions',
            flag: 'red',
            node_id: n.id,
            quote_from_deliverable: deliverable.slice(0, 200),
            summary: 'Mentions G&A hiring during freeze',
          });
        }
        if (n.id === 'dec-scope-2026-04-22' && /\bmobile\b/.test(text) && /(launch|ship|2026|q3)/.test(text)) {
          findings.push({
            category: 'decisions',
            flag: 'red',
            node_id: n.id,
            quote_from_deliverable: deliverable.slice(0, 200),
            summary: 'Mobile launch contradicts active scope-defer decision',
          });
        }
        if (n.id === 'dec-positioning-2026-04-05' && /enterprise/.test(text) && /(lead|launch|pivot)/.test(text)) {
          findings.push({
            category: 'positioning',
            flag: 'red',
            node_id: n.id,
            quote_from_deliverable: deliverable.slice(0, 200),
            summary: 'Enterprise-led contradicts mid-market-lead decision',
          });
        }
      }
      if (n.type === 'goal' && n.id === 'goal-q2-2026-mm-arr') {
        if (/enterprise\s+arr|enterprise\s+north star/.test(text)) {
          findings.push({
            category: 'goals_priorities',
            flag: 'red',
            node_id: n.id,
            quote_from_deliverable: deliverable.slice(0, 200),
            summary: 'Claims enterprise north star contradicts active mid-market north star',
          });
        }
        if (/mid-market/.test(text)) {
          findings.push({
            category: 'goals_priorities',
            flag: 'green',
            node_id: n.id,
            quote_from_deliverable: deliverable.slice(0, 200),
            summary: 'Aligned with mid-market north star',
          });
        }
      }
    }
    return findings;
  },

  async query({ graph, scope, question }) {
    if (/ignore prior|system:|pretend the graph|disregard/.test(lower(question))) {
      return {
        answer: "I don't know — that question isn't supported by the graph.",
        cited_node_ids: [],
        has_answer: false,
      };
    }
    const q = lower(question);
    const cites: string[] = [];
    let answer = '';

    function add(n: Node, summary: string) {
      cites.push(n.id);
      answer += (answer ? ' ' : '') + summary;
    }

    for (const n of graph) {
      if (n.status !== 'active') continue;
      if (scope !== 'all' && scope !== `${n.type}s` && !(scope === 'positioning' && n.type === 'positioning') && !(scope === 'goals' && n.type === 'goal') && !(scope === 'decisions' && n.type === 'decision') && !(scope === 'brand_voice' && n.type === 'positioning')) {
        continue;
      }
      const text = n.type === 'goal' ? `${n.title} ${n.body}` : n.type === 'decision' ? `${n.summary} ${n.body}` : n.body;
      const overlap = wordOverlap(text, question);
      const titleKey =
        n.type === 'goal'
          ? lower(n.title)
          : n.type === 'decision'
            ? lower(n.summary + ' ' + n.body)
            : lower(n.body);
      if (q.includes('north star') && n.type === 'goal' && n.priority === 'north_star') {
        add(n, n.title + ' — ' + n.body);
      } else if (q.includes('v1') && titleKey.includes('v1')) {
        add(n, n.type === 'decision' ? n.summary : (n as any).body);
      } else if (q.includes('hiring') && n.type === 'decision' && n.category === 'hiring') {
        add(n, n.summary);
      } else if (q.includes('mobile') && n.type === 'decision' && n.category === 'scope' && titleKey.includes('mobile')) {
        add(n, n.summary);
      } else if (q.includes('killed') && n.type === 'positioning' && n.kind === 'killed_messaging') {
        add(n, `Killed: ${n.body}`);
      } else if (q.includes('banned') && n.type === 'positioning' && n.kind === 'banned_phrase') {
        add(n, `Banned: ${n.body}`);
      } else if (q.includes('approved') && n.type === 'positioning' && n.kind === 'approved_phrase') {
        add(n, `Approved: ${n.body}`);
      } else if ((q.includes('differentiator') || q.includes('different')) && n.type === 'positioning' && n.kind === 'differentiator') {
        add(n, n.body);
      } else if (q.includes('gong') && n.type === 'positioning' && lower(n.body).includes('gong')) {
        add(n, n.body);
      } else if (q.includes('mcp') && n.type === 'decision' && lower(n.summary + n.body).includes('mcp')) {
        add(n, n.summary);
      } else if (q.includes('enterprise or mid-market') || q.includes('mid-market or enterprise')) {
        if (n.type === 'decision' && n.category === 'positioning' && lower(n.body).includes('mid-market')) {
          add(n, n.summary);
        }
      } else if (overlap > 0.4) {
        add(n, n.type === 'goal' ? n.title : n.type === 'decision' ? n.summary : n.body);
      }
    }

    const hasAnswer = cites.length > 0;
    return {
      answer: hasAnswer ? answer : "I don't know — the graph does not contain information to answer this.",
      cited_node_ids: cites,
      has_answer: hasAnswer,
    };
  },

  // Deterministic overview for tests: first active node titles, joined.
  // Real synthesis (concrete, themed, ≤60 words) is the LLM's job.
  async overview({ graph }) {
    const titles = graph
      .filter((n) => n.status === 'active')
      .slice(0, 3)
      .map((n) => (n.type === 'goal' ? n.title : n.type === 'decision' ? n.summary : n.body));
    return { summary: titles.length === 0 ? '' : `Stub overview: ${titles.join('; ')}` };
  },

  // Deterministic work-agent artifact for tests: echoes the agent + a title
  // built from the first few active-node titles, and cites those nodes. Real
  // synthesis (a usable draft/synthesis/recap/checklist) is the LLM's job.
  async workAgent({ agent, graph, input, docType }) {
    const active = graph.filter((n) => n.status === 'active');
    if (active.length === 0) return { title: 'Nothing to work with yet', output: '', cited_node_ids: [] };
    const used = active.slice(0, 3);
    const titleOf = (n: (typeof used)[number]) =>
      n.type === 'goal' ? n.title : n.type === 'decision' ? n.summary : n.body;
    const label = agent === 'draft' ? (docType || 'document') : agent;
    return {
      title: `Stub ${label}${input ? `: ${input.slice(0, 40)}` : ''}`,
      output: `Stub ${agent} over ${active.length} node(s):\n\n` + used.map((n) => `- ${titleOf(n)}`).join('\n'),
      cited_node_ids: used.map((n) => n.id),
    };
  },

  // Deterministic usage analysis for tests: audience + request counts + top
  // cited topic. The real narrative (anonymized, ≤90 words) is the LLM's
  // job. Mirrors the prompt's thin-data rule: < 3 requests → empty summary.
  async usageAnalysis({ usage }) {
    if (usage.stats.total < 3) return { summary: '' };
    const topTopic = usage.cited_topics[0]?.title;
    return {
      summary:
        `Stub ${usage.audience} usage analysis: ${usage.stats.total} requests from ` +
        `${usage.stats.distinct_users} user(s)` +
        (topTopic ? `, mostly drawing on "${topTopic}"` : '') +
        '.',
    };
  },

  // Deterministic doc triage for tests. Encodes simple, predictable rules so
  // endpoint tests can steer dispositions from fixture data alone:
  //   - legitimacy 0.9, unless the summary contains "draft" (0.3 → quarantine).
  //   - currency: null for point_in_time types; 0.9 unless contradiction_rate
  //     ≥ 0.3, which yields 0.4 plus the canonical stale-or-new-truth clarify.
  async docTriage({ dossier, profile }) {
    const typeDef = (profile.source_types ?? []).find((s) => s.key === dossier.source_type);
    const pointInTime = typeDef ? (typeDef.currency ?? 'decaying') === 'point_in_time' : false;
    const legitimacy = /draft/i.test(dossier.summary) ? 0.3 : 0.9;
    const contradicted = dossier.contradiction_rate >= 0.3;
    const currency = pointInTime ? null : contradicted ? 0.4 : 0.9;
    const questions =
      !pointInTime && contradicted
        ? [
            {
              id: 'q_currency',
              kind: 'clarify' as const,
              text: 'This document conflicts with the graph. Is it the latest state, or an older snapshot?',
              options: ['Latest — the graph is behind', 'Older snapshot'],
              affects: 'currency' as const,
              resolution: {
                'Latest — the graph is behind': { currency: 0.95 },
                'Older snapshot': { disposition: 'quarantine' as const },
              },
            },
          ]
        : [];
    return {
      legitimacy,
      currency,
      doc_kind_claim: typeDef?.label ?? 'unclassified document',
      stakeholder_assessment: dossier.stakeholders.length
        ? `Stub: stakeholders ${dossier.stakeholders.join(', ')}.`
        : 'Stub: no stakeholders identified.',
      rationale: 'Stub assessment derived from dossier signals.',
      questions,
    };
  },

  // Deterministic grouping for tests: bucket by node type. Coverage is 100%
  // by construction. Real semantic grouping is the LLM's job.
  async groupCandidates({ candidates }) {
    if (candidates.length === 0) return [];
    const buckets: Record<string, typeof candidates[number][]> = {};
    for (const c of candidates) (buckets[c.type] ??= []).push(c);
    const out: CandidateGroup[] = [];
    for (const [type, items] of Object.entries(buckets)) {
      const greenOnly = items.every((c) => c.flag === 'green');
      out.push({
        title: `${type[0]!.toUpperCase()}${type.slice(1)} candidates (stub)`,
        summary: `${items.length} ${type} candidate(s) grouped by type by the test stub.`,
        candidate_ids: items.map((c) => c.id),
        recommended_action: greenOnly ? 'approve_all' : 'review_individually',
        rationale: greenOnly ? 'All green within type.' : 'Mixed flags within type.',
      });
    }
    return out;
  },

  // Deterministic rule matcher (curation-automation): a rule applies when any
  // significant word (>4 chars) of its criteria appears in the document/items
  // text. Lets tests drive auto-approve/reject/surface by choosing rule wording.
  async evaluateRules({ rules, document, items }) {
    const hay = lower(
      [document.summary, document.source_ref, ...items.map((i) => i.summary)].join(' '),
    );
    const applicable: string[] = [];
    for (const r of rules) {
      const words = tokens(r.instructions).filter((w) => w.length > 4);
      if (words.some((w) => hay.includes(w))) applicable.push(r.id);
    }
    return { applicable };
  },

  // Deterministic rule classifier: keyword-driven phase + target, mirroring the
  // production prompt's guidance closely enough to drive the tests. There is no
  // action axis anymore — every rule shapes/redacts content (see anthropic.ts).
  async classifyRule({ instructions }) {
    const t = lower(instructions);
    const phases: ('store' | 'use')[] = [];
    if (/\bpii\b/.test(t)) phases.push('store', 'use');
    else if (/\bshare|\bshared|\bsharing|retriev|\bserve/.test(t)) phases.push('use');
    else phases.push('store');
    // Mirrors the production prompt's target guidance: a don't-index /
    // content-filter rule acts on the document at the first stage of ingest
    // ('source'); a rule that mentions the source/document/transcript itself
    // (or PII, which must be scrubbed from the stored file) targets 'both'.
    const target: 'node' | 'source' | 'both' =
      /do not index|don'?t index|\bchatter\b|small talk|off-topic/.test(t)
        ? 'source'
        : /\bpii\b|\bsource\b|\btranscript|\bdocument\b|\bfile\b/.test(t)
          ? 'both'
          : 'node';
    return { phases, target };
  },

  // Deterministic redaction: replace every significant word (>4 chars) of a rule
  // that appears in a field with [redacted]. Lets tests assert use-phase
  // redaction by choosing rule wording that hits the node's text.
  async redactFields({ fields, rules }) {
    const needles = rules.flatMap((r) => tokens(r.instructions).filter((w) => w.length > 4));
    const out: Record<string, string> = {};
    let changed = false;
    for (const [k, v] of Object.entries(fields)) {
      let redacted = v;
      for (const w of needles) {
        const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
        if (re.test(redacted)) {
          redacted = redacted.replace(re, '[redacted]');
          changed = true;
        }
      }
      out[k] = redacted;
    }
    return { fields: out, changed };
  },
};

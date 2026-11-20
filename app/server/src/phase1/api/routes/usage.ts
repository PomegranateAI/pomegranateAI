// Routes: usage.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import type { ContextUsageRow } from '../../db/repo.js';
import type { UsageAnalysisInput } from '../../../lib/schemas.js';
import { log } from '../../../lib/log.js';
import { withLlmContext } from '../../../lib/llm-context.js';
import { CachedSynth } from '../../synth/cached.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerUsage(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  repo,
  userEmail,
  profileFor,
  synth,
} = core;
// ---------- cross-user context usage ----------
//
// WHO drew on the context, what KIND of request it was, and — as of 2026-08
// — the verbatim request text (reversing the 2026-06 attribution-without-
// content split for this surface). The anonymized copy in
// context_request_texts still exists separately and continues to feed the
// synthesized usage-analysis narrative below.

/** Project an attributed usage row onto the API shape (0/1 → boolean). */
function usageRowOut(r: ContextUsageRow) {
  return {
    id: r.id,
    actor_user_id: r.actor_user_id,
    actor_email: r.actor_email,
    channel: r.channel,
    tool: r.tool,
    scope: r.scope,
    deliverable_kind: r.deliverable_kind,
    has_answer: r.has_answer === null ? null : !!r.has_answer,
    cited: r.cited,
    request_text: r.request_text,
    detail: r.detail ?? null,
    node_count: r.node_count,
    folder_name: r.subgraph_name ?? null,
    latency_ms: r.latency_ms,
    created_at: r.created_at,
  };
}

// Latest attributed usage of this workspace's context — the owner's "who is
// using my context" stream. Visible to every member: the transparency is
// reciprocal (anyone listed here can see the same list).
app.get('/workspaces/:ws/context-usage', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 200);
  // Paging: `before` = rows older than this id; `filter=unanswered` narrows
  // to "I don't know" replies. Totals let the page say "1–25 of 340".
  const before = Number(c.req.query('before')) || undefined;
  const unanswered = c.req.query('filter') === 'unanswered';
  const [rows, counts] = await Promise.all([
    repo.listContextUsage(ws, { limit, before, unanswered }),
    repo.countContextUsage(ws),
  ]);
  return c.json({ usage: rows.map(usageRowOut), total: counts.total, unanswered_total: counts.unanswered });
});

// The requester-side mirror: the current user's own requests across every
// workspace they belong to — "whose context have I been using, and for what".
app.get('/me/context-usage', authn, async (c) => {
  const user_id = c.get('user_id');
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 200);
  const me = await userEmail(user_id);
  const usage = (await repo.listContextUsageByUser(user_id, { limit })).map((r) => ({
    ...usageRowOut(r),
    workspace_id: r.workspace_id,
    workspace_name: r.workspace_name,
    owner_email: r.owner_email,
    own_context: r.owner_email === me,
  }));
  return c.json({ usage });
});

// Owner-facing synthesis of HOW the context is being used: counts by request
// kind + short LLM narratives built from the ANONYMIZED question store and
// the most-cited node titles. TWO slices, narrated separately: 'team'
// (everyone but the owner — "your context was called to review 3 PRDs…")
// and 'self' (the owner's own use — "you checked your own context…").
// Owner or workspace admin only. Each slice caches by its own usage
// signature; failure degrades to summary:null with the stats still served.
const USAGE_ANALYSIS_TTL_SEC = 6 * 3600;
const USAGE_ANALYSIS_WINDOW_DAYS = 30;
app.get('/workspaces/:ws/usage-analysis', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const owner_email = ((await repo.getWorkspace(ws))?.owner_email ?? '').toLowerCase();
  const isOwner = owner_email === (await userEmail(user_id) ?? '').toLowerCase();
  if (!isOwner && c.get('role') !== 'workspace_admin') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const sinceIso = new Date(Date.now() - USAGE_ANALYSIS_WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' '); // match sqlite datetime('now') format
  const rows = (await repo
    .listContextUsage(ws, { limit: 500 }))
    .filter((r) => r.created_at >= sinceIso);
  const isSelfRow = (r: (typeof rows)[number]) =>
    (r.actor_email ?? '').toLowerCase() === owner_email;

  // Anonymized question texts. by_owner=1 → the owner's own (self slice);
  // anything else, including legacy NULLs from before the flag existed,
  // counts as team — the only safe assumption for unattributed rows.
  const texts = await repo.listContextRequestTexts(ws, { limit: 100 });
  // Titles below go into an LLM prompt: aiRead as the caller, so other
  // members' private notes and anyone's only_me notes never reach it.
  const graph = await repo.listNodes(ws, { activeOnly: true, viewer: user_id, aiRead: true });
  const titleById = new Map(
    graph.map((n) => [
      n.id,
      String((n as any).title ?? (n as any).summary ?? (n as any).body ?? n.id).slice(0, 120),
    ]),
  );

  function buildSlice(audience: 'self' | 'team'): UsageAnalysisInput {
    const slice = rows.filter((r) => (audience === 'self' ? isSelfRow(r) : !isSelfRow(r)));
    const by_tool: Record<string, number> = {};
    const by_scope: Record<string, number> = {};
    const by_deliverable_kind: Record<string, number> = {};
    const users = new Set<string>();
    for (const r of slice) {
      by_tool[r.tool] = (by_tool[r.tool] ?? 0) + 1;
      if (r.scope) by_scope[r.scope] = (by_scope[r.scope] ?? 0) + 1;
      if (r.deliverable_kind)
        by_deliverable_kind[r.deliverable_kind] =
          (by_deliverable_kind[r.deliverable_kind] ?? 0) + 1;
      if (r.actor_user_id) users.add(r.actor_user_id);
    }
    const sliceTexts = texts.filter((t) =>
      audience === 'self' ? t.by_owner === 1 : t.by_owner !== 1,
    );
    const citeCounts = new Map<string, number>();
    for (const t of sliceTexts) {
      if (!t.cited_node_ids) continue;
      try {
        for (const id of JSON.parse(t.cited_node_ids) as string[]) {
          const title = titleById.get(id);
          if (title) citeCounts.set(title, (citeCounts.get(title) ?? 0) + 1);
        }
      } catch {
        // ignore malformed JSON
      }
    }
    return {
      audience,
      stats: {
        total: slice.length,
        distinct_users: users.size,
        by_tool,
        by_scope,
        by_deliverable_kind,
      },
      questions: sliceTexts
        .filter((t) => t.request_text)
        .slice(0, 50)
        .map((t) => ({
          tool: t.tool,
          scope: t.scope,
          text: t.request_text.slice(0, 300),
          has_answer: t.has_answer === null ? null : !!t.has_answer,
        })),
      cited_topics: [...citeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([title, count]) => ({ title, count })),
      window_days: USAGE_ANALYSIS_WINDOW_DAYS,
    };
  }

  const profile = await profileFor(ws);
  const cached = new CachedSynth(synth, repo, ws, USAGE_ANALYSIS_TTL_SEC, profile);
  async function narrate(usage: UsageAnalysisInput): Promise<string | null> {
    if (usage.stats.total === 0) return null;
    try {
      const { summary } = await withLlmContext(
        {
          caller: 'api.usage_analysis',
          context: { audience: usage.audience, request_count: usage.stats.total },
        },
        () => cached.usageAnalysis({ usage }),
      );
      return summary || null;
    } catch (err) {
      log.warn('usage_analysis.failed', {
        workspace: ws,
        audience: usage.audience,
        msg: (err as Error).message?.slice(0, 200),
      });
      return null;
    }
  }

  const selfInput = buildSlice('self');
  const teamInput = buildSlice('team');
  const [selfSummary, teamSummary] = await Promise.all([
    narrate(selfInput),
    narrate(teamInput),
  ]);
  return c.json({
    self: { summary: selfSummary, stats: selfInput.stats },
    team: { summary: teamSummary, stats: teamInput.stats },
  });
});
}

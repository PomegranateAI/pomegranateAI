// Routes: sources.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { z } from 'zod';
import * as path from 'node:path';
import { log } from '../../../lib/log.js';
import { APP_CATALOG } from '../app-sources.js';
import {
  gmailLiveConfigured,
  planGmailPull,
  fetchRecentGmail,
  filterGmailItems,
  cacheGmailPreview,
  getGmailPreview,
  renderGmailAggregate,
  gmailRunRef,
  type GmailLiveItem,
  type GmailPullPlan,
} from '../gmail-live.js';
import {
  githubLiveConfigured,
  planGithubPull,
  fetchRecentGithubPRs,
  filterGithubItems,
  cacheGithubPreview,
  getGithubPreview,
  renderGithubAggregate,
  githubRunRef,
  GithubRepoRequired,
  GithubUnsupportedContentType,
  type GithubPullPlan,
  type GithubLiveItem,
  planGithubFilesPull,
  fetchGithubFilesFromBranch,
  cacheGithubFilesPreview,
  getGithubFilesPreview,
  type GithubFilesPullPlan,
} from '../github-live.js';
import {
  slackLiveConfigured,
  planSlackPull,
  fetchRecentSlackMessages,
  extractSlackSelection,
  buildSlackSelectionItem,
  cacheSlackPreview,
  getSlackPreview,
  renderSlackAggregate,
  slackRunRef,
  SlackChannelRequired,
  type SlackPullPlan,
} from '../slack-live.js';
import {
  driveLiveConfigured,
  planDrivePull,
  searchDriveFiles,
  fetchDriveItems,
  cacheDrivePreview,
  getDrivePreview,
  DriveQueryRequired,
  DriveUnsupportedContentType,
  type DrivePullPlan,
} from '../drive-live.js';
import {
  notionLiveConfigured,
  planNotionPull,
  fetchNotionPages,
  fetchNotionPageContent,
  cacheNotionPreview,
  getNotionPreview,
  NotionQueryRequired,
  type NotionPullPlan,
} from '../notion-live.js';
import {
  fathomLiveConfigured,
  planFathomPull,
  fetchFathomMeetings,
  fetchFathomTranscript,
  cacheFathomPreview,
  getFathomPreview,
  FathomSearchRequired,
  type FathomPullPlan,
} from '../fathom-live.js';
import {
  teamsLiveConfigured,
  planTeamsPull,
  fetchTeamsMessages,
  cacheTeamsPreview,
  getTeamsPreview,
  renderTeamsAggregate,
  teamsRunRef,
  TeamsTargetRequired,
  type TeamsPullPlan,
} from '../teams-live.js';
import {
  jiraLiveConfigured,
  planJiraPull,
  fetchJiraProject,
  fetchJiraBoard,
  fetchJiraTickets,
  cacheJiraProjectPreview,
  getJiraProjectPreview,
  cacheJiraBoardPreview,
  getJiraBoardPreview,
  cacheJiraTicketsPreview,
  getJiraTicketsPreview,
  renderJiraProjectAggregate,
  renderJiraBoardAggregate,
  jiraProjectRunRef,
  jiraBoardRunRef,
  JiraProjectRequired,
  JiraBoardRequired,
  JiraTicketScopeRequired,
  type JiraPullPlan,
} from '../jira-live.js';
import { selectRelevantItems } from '../../../lib/batch-selection.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerSources(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  appConnected,
  repo,
  ingestForAppsPull,
  clientIp,
} = core;
// ---------- "From your apps" (Sources view) ----------
//
// Each app is LIVE per user via Composio OAuth (see app-sources.ts): once the
// caller has connected the account, preview plans the request with an LLM,
// fetches with THEIR connected account and filters with the Rules matcher;
// pull ingests the selection through the shared pipeline. An app the caller
// hasn't connected answers 409 app_not_connected.

// Connection status for every app in the catalog. Drives the connected/
// disconnected indicator in the Sources "From your apps" tab: an app is
// connected only when its keys/passwords are present (see appConnected),
// otherwise it reads as disconnected.
app.get('/workspaces/:ws/apps', authn, workspaceGate, async (c) => {
  const user_id = c.get('user_id');
  return c.json({
    apps: await Promise.all(Object.values(APP_CATALOG).map(async (a) => ({
      id: a.id,
      name: a.name,
      unit: a.unit,
      connected: await appConnected(a.id, user_id),
    }))),
  });
});

// Sidebar-hideable agents, by section. Collab agents reach outward into the
// team; work agents (spec-work-agents.md) act on the caller's own context. Both
// use the same per-user opt-in visibility model (no row = hidden).
const COLLAB_APP_IDS = new Set(['ask', 'updates', 'review']);
const WORK_AGENT_APP_IDS = new Set(['draft', 'synthesize', 'catchup', 'followup', 'broadcast']);
const HIDEABLE_APP_IDS = new Set([...COLLAB_APP_IDS, ...WORK_AGENT_APP_IDS]);

app.get('/workspaces/:ws/apps/visibility', authn, workspaceGate, async (c) => {
  const user_id = c.get('user_id');
  const ws = c.get('workspace_id');
  return c.json({ visible_apps: await repo.listUserWorkspaceVisibleApps(user_id, ws) });
});

app.post('/workspaces/:ws/apps/visibility/:app', authn, workspaceGate, async (c) => {
  const user_id = c.get('user_id');
  const ws = c.get('workspace_id');
  const appId = c.req.param('app');
  if (!HIDEABLE_APP_IDS.has(appId)) return c.json({ error: 'unknown_app' }, 404);
  await repo.setUserWorkspaceVisibleApp(user_id, ws, appId);
  return c.json({ visible_app: appId });
});

app.delete('/workspaces/:ws/apps/visibility/:app', authn, workspaceGate, async (c) => {
  const user_id = c.get('user_id');
  const ws = c.get('workspace_id');
  const appId = c.req.param('app');
  if (!HIDEABLE_APP_IDS.has(appId)) return c.json({ error: 'unknown_app' }, 404);
  await repo.clearUserWorkspaceVisibleApp(user_id, ws, appId);
  return c.json({ ok: true, visible_app: appId });
});

app.post('/workspaces/:ws/apps/:app/preview', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const appEntry = APP_CATALOG[c.req.param('app')];
  if (!appEntry) return c.json({ error: 'unknown_app' }, 404);
  const parsed = z
    .object({
      query: z.string().max(500),
      // GitHub only, files mode: 'prs' (default) is the existing aggregate
      // PR-pull; 'files' pulls files from a branch/path, one document per
      // file. repo/branch/path are the structured picker selections — when
      // repo is given, the plan is built directly from them (no LLM), same
      // reasoning as the repo picker for PRs but stricter: a branch name can
      // contain '/', which a string-injected-then-re-parsed query would mangle.
      mode: z.enum(['prs', 'files']).default('prs'),
      repo: z.string().trim().min(1).optional(),
      branch: z.string().trim().min(1).optional(),
      path: z.string().optional(),
      // Slack only: a picker-selected conversation id/name (channel, DM, or
      // group DM). DMs/group DMs have no natural freehand name (see
      // slack-live.ts's resolveSlackConversation), so the picker is the only
      // way to reach them — when given, the plan is built directly from it
      // (no LLM), same reasoning as GitHub's repo/branch bypass. query becomes
      // an optional topic filter in that case.
      channel: z.string().trim().min(1).optional(),
    })
    // query is only allowed empty for files mode with a picker-selected repo,
    // or for a picker-selected Slack conversation (it becomes an optional
    // topic filter there); every other app/mode still requires real text —
    // same validation strength as before this field existed.
    .refine((v) => v.query.trim().length > 0 || (v.mode === 'files' && !!v.repo) || !!v.channel, { message: 'query required' })
    .safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);

  const gmailConn = appEntry.id === 'gmail' ? await repo.getUserComposioConnection(c.get('user_id'), 'gmail') : undefined;
  const live = appEntry.id === 'gmail' && gmailLiveConfigured(gmailConn);
  const githubConn = appEntry.id === 'github' ? await repo.getUserComposioConnection(c.get('user_id'), 'github') : undefined;
  const githubLive = appEntry.id === 'github' && parsed.data.mode === 'prs' && githubLiveConfigured(githubConn);
  const githubFilesLive = appEntry.id === 'github' && parsed.data.mode === 'files' && githubLiveConfigured(githubConn);
  const slackConn = appEntry.id === 'slack' ? await repo.getUserComposioConnection(c.get('user_id'), 'slack') : undefined;
  const slackLive = appEntry.id === 'slack' && slackLiveConfigured(slackConn);
  const driveConn = appEntry.id === 'gdrive' ? await repo.getUserComposioConnection(c.get('user_id'), 'gdrive') : undefined;
  const driveLive = appEntry.id === 'gdrive' && driveLiveConfigured(driveConn);
  const notionConn = appEntry.id === 'notion' ? await repo.getUserComposioConnection(c.get('user_id'), 'notion') : undefined;
  const notionLive = appEntry.id === 'notion' && notionLiveConfigured(notionConn);
  const teamsConn = appEntry.id === 'microsoft_teams' ? await repo.getUserComposioConnection(c.get('user_id'), 'microsoft_teams') : undefined;
  const teamsLive = appEntry.id === 'microsoft_teams' && teamsLiveConfigured(teamsConn);
  const jiraConn = appEntry.id === 'jira' ? await repo.getUserComposioConnection(c.get('user_id'), 'jira') : undefined;
  const jiraLive = appEntry.id === 'jira' && jiraLiveConfigured(jiraConn);
  const fathomConn = appEntry.id === 'fathom' ? await repo.getUserComposioConnection(c.get('user_id'), 'fathom') : undefined;
  const fathomLive = appEntry.id === 'fathom' && fathomLiveConfigured(fathomConn);
  log.info('apps.preview', {
    workspace: ws,
    user: c.get('user_id'),
    app: appEntry.id,
    live: live || githubLive || githubFilesLive || slackLive || driveLive || notionLive || teamsLive || jiraLive || fathomLive,
  });

  if (live) {
    try {
      const plan = await planGmailPull(parsed.data.query);
      const fetched = await fetchRecentGmail(plan.count, c.get('user_id'), gmailConn!.connected_account_id);
      const matched = plan.filter ? await filterGmailItems(fetched, plan.filter) : fetched;
      // Keyed by workspace AND user: previews hold content fetched with the
      // caller's credentials, so another member must never pull from them.
      cacheGmailPreview(`${ws}:${c.get('user_id')}`, { query: parsed.data.query, plan, items: matched });
      return c.json({
        app: appEntry.id,
        unit: appEntry.unit,
        items: matched.map(({ id, title, meta, snippet }) => ({ id, title, meta, snippet })),
        live: true,
        plan: {
          count: plan.count,
          filter: plan.filter,
          audience: plan.audience,
          fetched: fetched.length,
          matched: matched.length,
        },
      });
    } catch (err) {
      log.info('apps.preview_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json({ error: 'gmail_unavailable', detail: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  if (githubLive) {
    try {
      const plan = await planGithubPull(parsed.data.query);
      const fetched = await fetchRecentGithubPRs(plan, c.get('user_id'), githubConn!.connected_account_id);
      const matched = plan.filter ? await filterGithubItems(fetched, plan.filter) : fetched;
      cacheGithubPreview(`${ws}:${c.get('user_id')}`, { query: parsed.data.query, plan, items: matched });
      return c.json({
        app: appEntry.id,
        unit: appEntry.unit,
        items: matched.map(({ id, title, meta, snippet }) => ({ id, title, meta, snippet })),
        live: true,
        plan: {
          repo: plan.repo,
          count: plan.count,
          filter: plan.filter,
          audience: plan.audience,
          fetched: fetched.length,
          matched: matched.length,
        },
      });
    } catch (err) {
      const repoMissing = err instanceof GithubRepoRequired;
      log.info('apps.preview_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        { error: repoMissing ? 'github_repo_required' : 'github_unavailable', detail: err instanceof Error ? err.message : String(err) },
        repoMissing ? 400 : 502,
      );
    }
  }

  if (githubFilesLive) {
    try {
      const plan: GithubFilesPullPlan = parsed.data.repo
        ? {
            repo: parsed.data.repo,
            branch: parsed.data.branch ?? null,
            path: parsed.data.path ?? '',
            filter: parsed.data.query.trim() || null,
            audience: 'private',
            title: `Files in ${parsed.data.path || '/'} on ${parsed.data.repo}${parsed.data.branch ? `@${parsed.data.branch}` : ''}`,
          }
        : await planGithubFilesPull(parsed.data.query);
      const fetched = await fetchGithubFilesFromBranch(plan, c.get('user_id'), githubConn!.connected_account_id);
      const matched = plan.filter ? await selectRelevantItems(fetched, plan.filter, { itemNoun: 'files' }) : fetched;
      cacheGithubFilesPreview(`${ws}:${c.get('user_id')}`, { query: parsed.data.query, plan, items: matched });
      return c.json({
        app: appEntry.id,
        unit: 'file',
        // Each file gets its own preview row — unlike PRs/Slack, files don't
        // collapse into one aggregate row (see Stage 1 plan notes).
        items: matched.map(({ id, title, meta, snippet }) => ({ id, title, meta, snippet })),
        live: true,
        plan: {
          repo: plan.repo,
          branch: plan.branch,
          path: plan.path,
          filter: plan.filter,
          audience: plan.audience,
          fetched: fetched.length,
          matched: matched.length,
        },
      });
    } catch (err) {
      const repoMissing = err instanceof GithubRepoRequired;
      const unsupportedType = err instanceof GithubUnsupportedContentType;
      log.info('apps.preview_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        {
          error: repoMissing ? 'github_repo_required' : unsupportedType ? 'github_unsupported_content_type' : 'github_unavailable',
          detail: err instanceof Error ? err.message : String(err),
        },
        repoMissing || unsupportedType ? 400 : 502,
      );
    }
  }

  if (slackLive) {
    try {
      const plan: SlackPullPlan = parsed.data.channel
        ? {
            channel: parsed.data.channel,
            count: 30,
            filter: parsed.data.query.trim() || null,
            audience: 'private',
            title: `Recent messages in ${parsed.data.channel}`,
          }
        : await planSlackPull(parsed.data.query);
      const fetched = await fetchRecentSlackMessages(plan, c.get('user_id'), slackConn!.connected_account_id);
      // No per-message picking: a plain request is the whole recent batch; a
      // topic request runs ONE selection pass over the batch (extractSlackSelection),
      // never a per-message checkbox. The preview always shows ONE row — "a
      // selection of messages" — not one row per message (buildSlackSelectionItem).
      const selected = plan.filter ? await extractSlackSelection(fetched, plan.filter) : fetched;
      cacheSlackPreview(`${ws}:${c.get('user_id')}`, { query: parsed.data.query, plan, items: selected });
      return c.json({
        app: appEntry.id,
        unit: 'selection',
        items: selected.length
          ? [(({ id, title, meta, snippet }) => ({ id, title, meta, snippet }))(buildSlackSelectionItem(selected, plan))]
          : [],
        live: true,
        plan: {
          channel: plan.channel,
          count: plan.count,
          filter: plan.filter,
          audience: plan.audience,
          fetched: fetched.length,
          matched: selected.length,
        },
      });
    } catch (err) {
      const channelMissing = err instanceof SlackChannelRequired;
      log.info('apps.preview_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        { error: channelMissing ? 'slack_channel_required' : 'slack_unavailable', detail: err instanceof Error ? err.message : String(err) },
        channelMissing ? 400 : 502,
      );
    }
  }

  if (driveLive) {
    try {
      const plan = await planDrivePull(parsed.data.query);
      const { items, mimeTypesById } = await searchDriveFiles(plan, c.get('user_id'), driveConn!.connected_account_id);
      cacheDrivePreview(`${ws}:${c.get('user_id')}`, { query: parsed.data.query, plan, items, mimeTypesById });
      return c.json({
        app: appEntry.id,
        unit: 'file',
        items: items.map(({ id, title, meta, snippet }) => ({ id, title, meta, snippet })),
        live: true,
        plan: { searchQuery: plan.searchQuery, audience: plan.audience, fetched: items.length, matched: items.length },
      });
    } catch (err) {
      const queryMissing = err instanceof DriveQueryRequired;
      log.info('apps.preview_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        { error: queryMissing ? 'drive_query_required' : 'drive_unavailable', detail: err instanceof Error ? err.message : String(err) },
        queryMissing ? 400 : 502,
      );
    }
  }

  if (notionLive) {
    try {
      const plan = await planNotionPull(parsed.data.query);
      const matches = await fetchNotionPages(plan, c.get('user_id'), notionConn!.connected_account_id);
      cacheNotionPreview(`${ws}:${c.get('user_id')}`, { query: parsed.data.query, plan, matches });
      return c.json({
        app: appEntry.id,
        unit: 'page',
        items: matches.map(({ id, title, meta, snippet }) => ({ id, title, meta, snippet })),
        live: true,
        plan: { query: plan.query, audience: plan.audience, fetched: matches.length, matched: matches.length },
      });
    } catch (err) {
      const queryMissing = err instanceof NotionQueryRequired;
      log.info('apps.preview_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        { error: queryMissing ? 'notion_query_required' : 'notion_unavailable', detail: err instanceof Error ? err.message : String(err) },
        queryMissing ? 400 : 502,
      );
    }
  }

  if (fathomLive) {
    try {
      const plan = await planFathomPull(parsed.data.query);
      const items = await fetchFathomMeetings(plan, c.get('user_id'), fathomConn!.connected_account_id);
      cacheFathomPreview(`${ws}:${c.get('user_id')}`, { query: parsed.data.query, plan, items });
      return c.json({
        app: appEntry.id,
        unit: 'meeting',
        items: items.map(({ id, title, meta }) => ({ id, title, meta, snippet: '' })),
        live: true,
        plan: { audience: plan.audience, fetched: items.length, matched: items.length },
      });
    } catch (err) {
      const searchMissing = err instanceof FathomSearchRequired;
      log.info('apps.preview_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        { error: searchMissing ? 'fathom_search_required' : 'fathom_unavailable', detail: err instanceof Error ? err.message : String(err) },
        searchMissing ? 400 : 502,
      );
    }
  }


  if (teamsLive) {
    try {
      const plan = await planTeamsPull(parsed.data.query);
      const fetched = await fetchTeamsMessages(plan, c.get('user_id'), teamsConn!.connected_account_id);
      const selected = plan.topic ? await selectRelevantItems(fetched, plan.topic, { itemNoun: 'messages' }) : fetched;
      cacheTeamsPreview(`${ws}:${c.get('user_id')}`, { query: parsed.data.query, plan, items: selected });
      return c.json({
        app: appEntry.id,
        unit: 'selection',
        items: selected.length
          ? [{ id: 'selection', title: plan.title, meta: `${selected.length} message${selected.length === 1 ? '' : 's'}`, snippet: selected.map((i) => i.snippet).join(' — ').slice(0, 140) }]
          : [],
        live: true,
        plan: { mode: plan.mode, count: plan.count, topic: plan.topic, audience: plan.audience, fetched: fetched.length, matched: selected.length },
      });
    } catch (err) {
      const targetMissing = err instanceof TeamsTargetRequired;
      log.info('apps.preview_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        { error: targetMissing ? 'teams_target_required' : 'teams_unavailable', detail: err instanceof Error ? err.message : String(err) },
        targetMissing ? 400 : 502,
      );
    }
  }

  if (jiraLive) {
    try {
      const plan = await planJiraPull(parsed.data.query);
      if (plan.mode === 'project') {
        const { meta, issues } = await fetchJiraProject(plan, c.get('user_id'), jiraConn!.connected_account_id);
        cacheJiraProjectPreview(`${ws}:${c.get('user_id')}`, { query: parsed.data.query, plan, meta, issues });
        return c.json({
          app: appEntry.id,
          unit: 'selection',
          items: [{ id: 'selection', title: plan.title, meta: `${issues.length} issue${issues.length === 1 ? '' : 's'} · ${meta.name}`, snippet: meta.description?.slice(0, 140) ?? '' }],
          live: true,
          plan: { mode: plan.mode, project: plan.project, audience: plan.audience, fetched: issues.length, matched: issues.length },
        });
      }
      if (plan.mode === 'board') {
        const { meta, issues } = await fetchJiraBoard(plan, c.get('user_id'), jiraConn!.connected_account_id);
        cacheJiraBoardPreview(`${ws}:${c.get('user_id')}`, { query: parsed.data.query, plan, meta, issues });
        return c.json({
          app: appEntry.id,
          unit: 'selection',
          items: [{ id: 'selection', title: plan.title, meta: `${issues.length} issue${issues.length === 1 ? '' : 's'} · ${meta.name}`, snippet: meta.sprint ? `Sprint: ${meta.sprint.name}` : '' }],
          live: true,
          plan: { mode: plan.mode, board: plan.board, audience: plan.audience, fetched: issues.length, matched: issues.length },
        });
      }
      // ticket mode — per-item, not aggregated (mirrors GitHub files-mode)
      const items = await fetchJiraTickets(plan, c.get('user_id'), jiraConn!.connected_account_id);
      cacheJiraTicketsPreview(`${ws}:${c.get('user_id')}`, { query: parsed.data.query, plan, items });
      return c.json({
        app: appEntry.id,
        unit: 'ticket',
        items: items.map(({ id, title, meta, snippet }) => ({ id, title, meta, snippet })),
        live: true,
        plan: { mode: plan.mode, project: plan.project, board: plan.board, filter: plan.filter, audience: plan.audience, fetched: items.length, matched: items.length },
      });
    } catch (err) {
      const badRequest =
        err instanceof JiraProjectRequired || err instanceof JiraBoardRequired || err instanceof JiraTicketScopeRequired;
      log.info('apps.preview_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        { error: badRequest ? 'jira_scope_required' : 'jira_unavailable', detail: err instanceof Error ? err.message : String(err) },
        badRequest ? 400 : 502,
      );
    }
  }

  return c.json({ error: 'app_not_connected', app: appEntry.id }, 409);
});

app.post('/workspaces/:ws/apps/:app/pull', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const appEntry = APP_CATALOG[c.req.param('app')];
  if (!appEntry) return c.json({ error: 'unknown_app' }, 404);
  const parsed = z
    .object({
      // Empty allowed: GitHub files mode with a repo picker selection has no
      // required free text (query becomes an optional topic filter only).
      // Every other app/mode still effectively requires it — an empty query
      // reaching a planner surfaces its own clear error downstream.
      query: z.string().max(500),
      item_ids: z.array(z.string()).min(1).max(200),
      subgraph_id: z.string().optional(),
      // Same field, same engine (runInstructedIngest/add-source-agent) as
      // Upload/Paste's InstructionsField — mutually exclusive with
      // subgraph_id in practice (the UI hides the destination picker once
      // instructions are given); the agent's own folder choice wins if both arrive.
      instructions: z.string().min(1).optional(),
      // GitHub only — see the matching fields on /preview.
      mode: z.enum(['prs', 'files']).default('prs'),
      repo: z.string().trim().min(1).optional(),
      branch: z.string().trim().min(1).optional(),
      path: z.string().optional(),
      // Slack only — see the matching field on /preview.
      channel: z.string().trim().min(1).optional(),
    })
    .refine((v) => v.query.trim().length > 0 || (v.mode === 'files' && !!v.repo) || !!v.channel, { message: 'query required' })
    .safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);

  if (parsed.data.subgraph_id && (await repo.getSubgraph(ws, parsed.data.subgraph_id))?.status !== 'active') {
    return c.json({ error: 'invalid_subgraph' }, 400);
  }

  const gmailConn = appEntry.id === 'gmail' ? await repo.getUserComposioConnection(c.get('user_id'), 'gmail') : undefined;
  if (appEntry.id === 'gmail' && gmailLiveConfigured(gmailConn)) {
    try {
      // Reuse the previewed batch when it's still fresh (same query, <10 min);
      // otherwise replan + refetch — Gmail message ids are stable, so selection holds.
      const cached = getGmailPreview(`${ws}:${c.get('user_id')}`, parsed.data.query);
      let plan: GmailPullPlan;
      let pool: GmailLiveItem[];
      if (cached) {
        ({ plan, items: pool } = cached);
      } else {
        plan = await planGmailPull(parsed.data.query);
        const fetched = await fetchRecentGmail(plan.count, c.get('user_id'), gmailConn!.connected_account_id);
        pool = plan.filter ? await filterGmailItems(fetched, plan.filter) : fetched;
      }
      const items = pool.filter((i) => parsed.data.item_ids.includes(i.id));
      if (items.length === 0) return c.json({ error: 'no_matching_items' }, 400);

      log.info('apps.pull', {
        workspace: ws,
        user: c.get('user_id'),
        app: appEntry.id,
        items: items.length,
        live: true,
        audience: plan.audience,
        instructed: !!parsed.data.instructions,
      });

      // ONE source per run: aggregate the selected emails into a single
      // document and send it through the one shared ingest pipeline.
      const title = gmailRunRef(plan);
      const r = await ingestForAppsPull({
        ws,
        user_id: c.get('user_id'),
        source: renderGmailAggregate({ query: parsed.data.query, plan, items }),
        source_kind: 'doc',
        source_ref: title,
        source_ip: clientIp(c),
        user_agent: c.req.header('user-agent') ?? undefined,
        audience: plan.audience,
        forcedSubgraphId: parsed.data.subgraph_id,
        instructions: parsed.data.instructions,
      });
      return c.json({
        app: appEntry.id,
        query: parsed.data.query,
        live: true,
        audience: plan.audience,
        results: r.document_id ? [{ id: 'gmail_run', title, document_id: r.document_id, candidates: r.candidates }] : [],
        total_candidates: r.candidates,
        message: r.message,
      });
    } catch (err) {
      log.info('apps.pull_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json({ error: 'gmail_unavailable', detail: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  const githubConn = appEntry.id === 'github' ? await repo.getUserComposioConnection(c.get('user_id'), 'github') : undefined;
  if (appEntry.id === 'github' && parsed.data.mode === 'prs' && githubLiveConfigured(githubConn)) {
    try {
      // Same cache-or-replan handoff as Gmail: reuse the previewed batch when
      // still fresh, otherwise replan + refetch.
      const cached = getGithubPreview(`${ws}:${c.get('user_id')}`, parsed.data.query);
      let plan: GithubPullPlan;
      let pool: Awaited<ReturnType<typeof fetchRecentGithubPRs>>;
      if (cached) {
        ({ plan, items: pool } = cached);
      } else {
        plan = await planGithubPull(parsed.data.query);
        const fetched = await fetchRecentGithubPRs(plan, c.get('user_id'), githubConn!.connected_account_id);
        pool = plan.filter ? await filterGithubItems(fetched, plan.filter) : fetched;
      }
      const items = pool.filter((i) => parsed.data.item_ids.includes(i.id));
      if (items.length === 0) return c.json({ error: 'no_matching_items' }, 400);

      log.info('apps.pull', {
        workspace: ws,
        user: c.get('user_id'),
        app: appEntry.id,
        items: items.length,
        live: true,
        audience: plan.audience,
        instructed: !!parsed.data.instructions,
      });

      const title = githubRunRef(plan);
      const r = await ingestForAppsPull({
        ws,
        user_id: c.get('user_id'),
        source: renderGithubAggregate({ query: parsed.data.query, plan, items }),
        source_kind: 'doc',
        source_ref: title,
        source_ip: clientIp(c),
        user_agent: c.req.header('user-agent') ?? undefined,
        audience: plan.audience,
        forcedSubgraphId: parsed.data.subgraph_id,
        instructions: parsed.data.instructions,
      });
      return c.json({
        app: appEntry.id,
        query: parsed.data.query,
        live: true,
        audience: plan.audience,
        results: r.document_id ? [{ id: 'github_run', title, document_id: r.document_id, candidates: r.candidates }] : [],
        total_candidates: r.candidates,
        message: r.message,
      });
    } catch (err) {
      const repoMissing = err instanceof GithubRepoRequired;
      log.info('apps.pull_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        { error: repoMissing ? 'github_repo_required' : 'github_unavailable', detail: err instanceof Error ? err.message : String(err) },
        repoMissing ? 400 : 502,
      );
    }
  }

  if (appEntry.id === 'github' && parsed.data.mode === 'files' && githubLiveConfigured(githubConn)) {
    try {
      const cached = getGithubFilesPreview(`${ws}:${c.get('user_id')}`, parsed.data.query);
      let plan: GithubFilesPullPlan;
      let pool: GithubLiveItem[];
      if (cached) {
        ({ plan, items: pool } = cached);
      } else {
        plan = parsed.data.repo
          ? {
              repo: parsed.data.repo,
              branch: parsed.data.branch ?? null,
              path: parsed.data.path ?? '',
              filter: parsed.data.query.trim() || null,
              audience: 'private',
              title: `Files in ${parsed.data.path || '/'} on ${parsed.data.repo}${parsed.data.branch ? `@${parsed.data.branch}` : ''}`,
            }
          : await planGithubFilesPull(parsed.data.query);
        const fetched = await fetchGithubFilesFromBranch(plan, c.get('user_id'), githubConn!.connected_account_id);
        pool = plan.filter ? await selectRelevantItems(fetched, plan.filter, { itemNoun: 'files' }) : fetched;
      }
      const items = pool.filter((i) => parsed.data.item_ids.includes(i.id));
      if (items.length === 0) return c.json({ error: 'no_matching_items' }, 400);

      log.info('apps.pull', {
        workspace: ws,
        user: c.get('user_id'),
        app: appEntry.id,
        items: items.length,
        live: true,
        audience: plan.audience,
        instructed: !!parsed.data.instructions,
      });

      // Each file is its own document — per-item ingest (not the aggregate
      // path PRs use), reusing the same shared per-item ingest helper so
      // `instructions` runs the full agent loop once
      // PER FILE when given (per product decision — MAX_FILES already caps
      // this at fetch time, so the cap is inherent, not extra code here).
      const results: Array<{ id: string; title: string; document_id: string; candidates: number }> = [];
      for (const item of items) {
        const r = await ingestForAppsPull({
          ws,
          user_id: c.get('user_id'),
          source: item.body,
          source_kind: 'doc',
          source_ref: item.title,
          source_ip: clientIp(c),
          user_agent: c.req.header('user-agent') ?? undefined,
          audience: plan.audience,
          forcedSubgraphId: parsed.data.subgraph_id,
          instructions: parsed.data.instructions,
        });
        if (r.document_id) results.push({ id: item.id, title: item.title, document_id: r.document_id, candidates: r.candidates });
      }
      return c.json({
        app: appEntry.id,
        query: parsed.data.query,
        live: true,
        audience: plan.audience,
        results,
        total_candidates: results.reduce((sum, r) => sum + r.candidates, 0),
      });
    } catch (err) {
      const repoMissing = err instanceof GithubRepoRequired;
      const unsupportedType = err instanceof GithubUnsupportedContentType;
      log.info('apps.pull_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        {
          error: repoMissing ? 'github_repo_required' : unsupportedType ? 'github_unsupported_content_type' : 'github_unavailable',
          detail: err instanceof Error ? err.message : String(err),
        },
        repoMissing || unsupportedType ? 400 : 502,
      );
    }
  }

  const slackConn = appEntry.id === 'slack' ? await repo.getUserComposioConnection(c.get('user_id'), 'slack') : undefined;
  if (appEntry.id === 'slack' && slackLiveConfigured(slackConn)) {
    try {
      const cached = getSlackPreview(`${ws}:${c.get('user_id')}`, parsed.data.query);
      let plan: SlackPullPlan;
      let pool: Awaited<ReturnType<typeof fetchRecentSlackMessages>>;
      if (cached) {
        ({ plan, items: pool } = cached);
      } else {
        plan = parsed.data.channel
          ? {
              channel: parsed.data.channel,
              count: 30,
              filter: parsed.data.query.trim() || null,
              audience: 'private',
              title: `Recent messages in ${parsed.data.channel}`,
            }
          : await planSlackPull(parsed.data.query);
        const fetched = await fetchRecentSlackMessages(plan, c.get('user_id'), slackConn!.connected_account_id);
        pool = plan.filter ? await extractSlackSelection(fetched, plan.filter) : fetched;
      }
      // No per-message picking here either — item_ids carries only the one
      // synthetic "selection" row id from preview; the real selection is the
      // whole cached/re-fetched pool.
      const items = pool;
      if (items.length === 0) return c.json({ error: 'no_matching_items' }, 400);

      log.info('apps.pull', {
        workspace: ws,
        user: c.get('user_id'),
        app: appEntry.id,
        items: items.length,
        live: true,
        audience: plan.audience,
        instructed: !!parsed.data.instructions,
      });

      const title = slackRunRef(plan);
      const r = await ingestForAppsPull({
        ws,
        user_id: c.get('user_id'),
        source: renderSlackAggregate({ query: parsed.data.query, plan, items }),
        source_kind: 'slack',
        source_ref: title,
        source_ip: clientIp(c),
        user_agent: c.req.header('user-agent') ?? undefined,
        audience: plan.audience,
        forcedSubgraphId: parsed.data.subgraph_id,
        instructions: parsed.data.instructions,
      });
      return c.json({
        app: appEntry.id,
        query: parsed.data.query,
        live: true,
        audience: plan.audience,
        results: r.document_id ? [{ id: 'slack_run', title, document_id: r.document_id, candidates: r.candidates }] : [],
        total_candidates: r.candidates,
        message: r.message,
      });
    } catch (err) {
      const channelMissing = err instanceof SlackChannelRequired;
      log.info('apps.pull_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        { error: channelMissing ? 'slack_channel_required' : 'slack_unavailable', detail: err instanceof Error ? err.message : String(err) },
        channelMissing ? 400 : 502,
      );
    }
  }

  const driveConn = appEntry.id === 'gdrive' ? await repo.getUserComposioConnection(c.get('user_id'), 'gdrive') : undefined;
  if (appEntry.id === 'gdrive' && driveLiveConfigured(driveConn)) {
    try {
      const cached = getDrivePreview(`${ws}:${c.get('user_id')}`, parsed.data.query);
      let plan: DrivePullPlan;
      let items: Awaited<ReturnType<typeof searchDriveFiles>>['items'];
      let mimeTypesById: Awaited<ReturnType<typeof searchDriveFiles>>['mimeTypesById'];
      if (cached) {
        ({ plan, items, mimeTypesById } = cached);
      } else {
        plan = await planDrivePull(parsed.data.query);
        ({ items, mimeTypesById } = await searchDriveFiles(plan, c.get('user_id'), driveConn!.connected_account_id));
      }
      const chosen = await fetchDriveItems(items, parsed.data.item_ids, mimeTypesById, c.get('user_id'), driveConn!.connected_account_id);
      if (chosen.length === 0) return c.json({ error: 'no_matching_items' }, 400);
      log.info('apps.pull', { workspace: ws, user: c.get('user_id'), app: appEntry.id, items: chosen.length, live: true, audience: plan.audience, instructed: !!parsed.data.instructions });
      const results: Array<{ id: string; title: string; document_id: string; candidates: number }> = [];
      for (const item of chosen) {
        const r = await ingestForAppsPull({
          ws, user_id: c.get('user_id'), source: item.body, source_kind: 'doc', source_ref: item.title,
          source_ip: clientIp(c), user_agent: c.req.header('user-agent') ?? undefined,
          audience: plan.audience, forcedSubgraphId: parsed.data.subgraph_id, instructions: parsed.data.instructions,
        });
        if (r.document_id) results.push({ id: item.id, title: item.title, document_id: r.document_id, candidates: r.candidates });
      }
      return c.json({ app: appEntry.id, query: parsed.data.query, live: true, audience: plan.audience, results, total_candidates: results.reduce((s, r) => s + r.candidates, 0) });
    } catch (err) {
      const queryMissing = err instanceof DriveQueryRequired;
      const unsupportedType = err instanceof DriveUnsupportedContentType;
      log.info('apps.pull_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        {
          error: queryMissing ? 'drive_query_required' : unsupportedType ? 'drive_unsupported_content_type' : 'drive_unavailable',
          detail: err instanceof Error ? err.message : String(err),
        },
        queryMissing || unsupportedType ? 400 : 502,
      );
    }
  }

  const notionConn = appEntry.id === 'notion' ? await repo.getUserComposioConnection(c.get('user_id'), 'notion') : undefined;
  if (appEntry.id === 'notion' && notionLiveConfigured(notionConn)) {
    try {
      const cached = getNotionPreview(`${ws}:${c.get('user_id')}`, parsed.data.query);
      let plan: NotionPullPlan;
      let matches: Awaited<ReturnType<typeof fetchNotionPages>>;
      if (cached) {
        ({ plan, matches } = cached);
      } else {
        plan = await planNotionPull(parsed.data.query);
        matches = await fetchNotionPages(plan, c.get('user_id'), notionConn!.connected_account_id);
      }
      const wanted = new Set(parsed.data.item_ids);
      const chosenMatches = matches.filter((m) => wanted.has(m.id));
      if (chosenMatches.length === 0) return c.json({ error: 'no_matching_items' }, 400);
      log.info('apps.pull', { workspace: ws, user: c.get('user_id'), app: appEntry.id, items: chosenMatches.length, live: true, audience: plan.audience, instructed: !!parsed.data.instructions });
      const results: Array<{ id: string; title: string; document_id: string; candidates: number }> = [];
      for (const match of chosenMatches) {
        const item = await fetchNotionPageContent(match.id, c.get('user_id'), notionConn!.connected_account_id);
        const r = await ingestForAppsPull({
          ws, user_id: c.get('user_id'), source: item.body, source_kind: 'doc', source_ref: item.title,
          source_ip: clientIp(c), user_agent: c.req.header('user-agent') ?? undefined,
          audience: plan.audience, forcedSubgraphId: parsed.data.subgraph_id, instructions: parsed.data.instructions,
        });
        if (r.document_id) results.push({ id: item.id, title: item.title, document_id: r.document_id, candidates: r.candidates });
      }
      return c.json({ app: appEntry.id, query: parsed.data.query, live: true, audience: plan.audience, results, total_candidates: results.reduce((s, r) => s + r.candidates, 0) });
    } catch (err) {
      const queryMissing = err instanceof NotionQueryRequired;
      log.info('apps.pull_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        { error: queryMissing ? 'notion_query_required' : 'notion_unavailable', detail: err instanceof Error ? err.message : String(err) },
        queryMissing ? 400 : 502,
      );
    }
  }

  const fathomConn = appEntry.id === 'fathom' ? await repo.getUserComposioConnection(c.get('user_id'), 'fathom') : undefined;
  if (appEntry.id === 'fathom' && fathomLiveConfigured(fathomConn)) {
    try {
      const cached = getFathomPreview(`${ws}:${c.get('user_id')}`, parsed.data.query);
      let plan: FathomPullPlan;
      let items: Awaited<ReturnType<typeof fetchFathomMeetings>>;
      if (cached) {
        ({ plan, items } = cached);
      } else {
        plan = await planFathomPull(parsed.data.query);
        items = await fetchFathomMeetings(plan, c.get('user_id'), fathomConn!.connected_account_id);
      }
      const wanted = new Set(parsed.data.item_ids);
      const chosenMeetings = items.filter((m) => wanted.has(m.id));
      if (chosenMeetings.length === 0) return c.json({ error: 'no_matching_items' }, 400);
      log.info('apps.pull', { workspace: ws, user: c.get('user_id'), app: appEntry.id, items: chosenMeetings.length, live: true, audience: plan.audience, instructed: !!parsed.data.instructions });
      const results: Array<{ id: string; title: string; document_id: string; candidates: number }> = [];
      for (const meeting of chosenMeetings) {
        const item = await fetchFathomTranscript(meeting.id, c.get('user_id'), fathomConn!.connected_account_id);
        const r = await ingestForAppsPull({
          ws, user_id: c.get('user_id'), source: item.body, source_kind: 'transcript', source_ref: item.title,
          source_ip: clientIp(c), user_agent: c.req.header('user-agent') ?? undefined,
          audience: plan.audience, forcedSubgraphId: parsed.data.subgraph_id, instructions: parsed.data.instructions,
        });
        if (r.document_id) results.push({ id: item.id, title: item.title, document_id: r.document_id, candidates: r.candidates });
      }
      return c.json({ app: appEntry.id, query: parsed.data.query, live: true, audience: plan.audience, results, total_candidates: results.reduce((s, r) => s + r.candidates, 0) });
    } catch (err) {
      const searchMissing = err instanceof FathomSearchRequired;
      log.info('apps.pull_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        { error: searchMissing ? 'fathom_search_required' : 'fathom_unavailable', detail: err instanceof Error ? err.message : String(err) },
        searchMissing ? 400 : 502,
      );
    }
  }


  const teamsConn = appEntry.id === 'microsoft_teams' ? await repo.getUserComposioConnection(c.get('user_id'), 'microsoft_teams') : undefined;
  if (appEntry.id === 'microsoft_teams' && teamsLiveConfigured(teamsConn)) {
    try {
      const cached = getTeamsPreview(`${ws}:${c.get('user_id')}`, parsed.data.query);
      let plan: TeamsPullPlan;
      let pool: Awaited<ReturnType<typeof fetchTeamsMessages>>;
      if (cached) {
        ({ plan, items: pool } = cached);
      } else {
        plan = await planTeamsPull(parsed.data.query);
        const fetched = await fetchTeamsMessages(plan, c.get('user_id'), teamsConn!.connected_account_id);
        pool = plan.topic ? await selectRelevantItems(fetched, plan.topic, { itemNoun: 'messages' }) : fetched;
      }
      const items = pool;
      if (items.length === 0) return c.json({ error: 'no_matching_items' }, 400);
      log.info('apps.pull', { workspace: ws, user: c.get('user_id'), app: appEntry.id, items: items.length, live: true, audience: plan.audience, instructed: !!parsed.data.instructions });
      const title = teamsRunRef(plan);
      const r = await ingestForAppsPull({
        ws, user_id: c.get('user_id'), source: renderTeamsAggregate({ query: parsed.data.query, plan, items }), source_kind: 'doc', source_ref: title,
        source_ip: clientIp(c), user_agent: c.req.header('user-agent') ?? undefined,
        audience: plan.audience, forcedSubgraphId: parsed.data.subgraph_id, instructions: parsed.data.instructions,
      });
      return c.json({ app: appEntry.id, query: parsed.data.query, live: true, audience: plan.audience, results: r.document_id ? [{ id: 'teams_run', title, document_id: r.document_id, candidates: r.candidates }] : [], total_candidates: r.candidates, message: r.message });
    } catch (err) {
      const targetMissing = err instanceof TeamsTargetRequired;
      log.info('apps.pull_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        { error: targetMissing ? 'teams_target_required' : 'teams_unavailable', detail: err instanceof Error ? err.message : String(err) },
        targetMissing ? 400 : 502,
      );
    }
  }

  const jiraConn = appEntry.id === 'jira' ? await repo.getUserComposioConnection(c.get('user_id'), 'jira') : undefined;
  if (appEntry.id === 'jira' && jiraLiveConfigured(jiraConn)) {
    try {
      let plan: JiraPullPlan;
      const cachedProject = getJiraProjectPreview(`${ws}:${c.get('user_id')}`, parsed.data.query);
      const cachedBoard = getJiraBoardPreview(`${ws}:${c.get('user_id')}`, parsed.data.query);
      const cachedTickets = getJiraTicketsPreview(`${ws}:${c.get('user_id')}`, parsed.data.query);
      if (cachedProject) {
        plan = cachedProject.plan;
      } else if (cachedBoard) {
        plan = cachedBoard.plan;
      } else if (cachedTickets) {
        plan = cachedTickets.plan;
      } else {
        plan = await planJiraPull(parsed.data.query);
      }

      log.info('apps.pull', { workspace: ws, user: c.get('user_id'), app: appEntry.id, live: true, audience: plan.audience, instructed: !!parsed.data.instructions, mode: plan.mode });

      if (plan.mode === 'project') {
        const { meta, issues } = cachedProject ?? await fetchJiraProject(plan, c.get('user_id'), jiraConn!.connected_account_id);
        const title = jiraProjectRunRef(plan);
        const r = await ingestForAppsPull({
          ws, user_id: c.get('user_id'), source: renderJiraProjectAggregate({ query: parsed.data.query, plan, meta, issues }), source_kind: 'doc', source_ref: title,
          source_ip: clientIp(c), user_agent: c.req.header('user-agent') ?? undefined,
          audience: plan.audience, forcedSubgraphId: parsed.data.subgraph_id, instructions: parsed.data.instructions,
        });
        return c.json({ app: appEntry.id, query: parsed.data.query, live: true, audience: plan.audience, results: r.document_id ? [{ id: 'jira_project_run', title, document_id: r.document_id, candidates: r.candidates }] : [], total_candidates: r.candidates, message: r.message });
      }
      if (plan.mode === 'board') {
        const { meta, issues } = cachedBoard ?? await fetchJiraBoard(plan, c.get('user_id'), jiraConn!.connected_account_id);
        const title = jiraBoardRunRef(plan);
        const r = await ingestForAppsPull({
          ws, user_id: c.get('user_id'), source: renderJiraBoardAggregate({ query: parsed.data.query, plan, meta, issues }), source_kind: 'doc', source_ref: title,
          source_ip: clientIp(c), user_agent: c.req.header('user-agent') ?? undefined,
          audience: plan.audience, forcedSubgraphId: parsed.data.subgraph_id, instructions: parsed.data.instructions,
        });
        return c.json({ app: appEntry.id, query: parsed.data.query, live: true, audience: plan.audience, results: r.document_id ? [{ id: 'jira_board_run', title, document_id: r.document_id, candidates: r.candidates }] : [], total_candidates: r.candidates, message: r.message });
      }
      // ticket mode — per-item ingest
      const pool = cachedTickets?.items ?? await fetchJiraTickets(plan, c.get('user_id'), jiraConn!.connected_account_id);
      const wanted = new Set(parsed.data.item_ids);
      const chosen = pool.filter((i) => wanted.has(i.id));
      if (chosen.length === 0) return c.json({ error: 'no_matching_items' }, 400);
      const results: Array<{ id: string; title: string; document_id: string; candidates: number }> = [];
      for (const item of chosen) {
        const r = await ingestForAppsPull({
          ws, user_id: c.get('user_id'), source: item.body, source_kind: 'doc', source_ref: item.title,
          source_ip: clientIp(c), user_agent: c.req.header('user-agent') ?? undefined,
          audience: plan.audience, forcedSubgraphId: parsed.data.subgraph_id, instructions: parsed.data.instructions,
        });
        if (r.document_id) results.push({ id: item.id, title: item.title, document_id: r.document_id, candidates: r.candidates });
      }
      return c.json({ app: appEntry.id, query: parsed.data.query, live: true, audience: plan.audience, results, total_candidates: results.reduce((s, r) => s + r.candidates, 0) });
    } catch (err) {
      const badRequest =
        err instanceof JiraProjectRequired || err instanceof JiraBoardRequired || err instanceof JiraTicketScopeRequired;
      log.info('apps.pull_live_failed', { workspace: ws, app: appEntry.id, error: String(err) });
      return c.json(
        { error: badRequest ? 'jira_scope_required' : 'jira_unavailable', detail: err instanceof Error ? err.message : String(err) },
        badRequest ? 400 : 502,
      );
    }
  }

  return c.json({ error: 'app_not_connected', app: appEntry.id }, 409);
});
}

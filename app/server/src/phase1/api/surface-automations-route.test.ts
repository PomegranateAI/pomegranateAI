/**
 * Slack listen automations — the /agent/surface/automations/* relay endpoints
 * (Stage 5: migrating channel-listen subscriptions out of surfaces/slack's
 * JSON file into the shared automations table, kind='slack_listen').
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-surface-auto-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
  // These tests link identities directly; the link-code flow is covered in
  // identity-link.test.ts.
  process.env.POMEGRANATE_ALLOW_UNVERIFIED_IDENTITY_LINK = '1';
  process.env.SURFACE_AGENT_SECRET = 'shh-relay';
});

async function loadApp() {
  return import('./server.js?surface-auto=' + Date.now());
}

async function call(
  app: any,
  method: string,
  url: string,
  opts: { token?: string; body?: unknown; surfaceSecret?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.surfaceSecret) headers['x-surface-secret'] = opts.surfaceSecret;
  const r = await app.request(url, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function magic(app: any, email: string): Promise<string> {
  const r1 = await call(app, 'POST', '/auth/magic-link', { body: { email } });
  const r2 = await call(app, 'POST', '/auth/exchange', { body: { code: r1.json.dev_code } });
  return r2.json.session as string;
}

let seq = 0;
// Each call gets its OWN team_id — team_id is the isolation boundary the
// /due endpoint filters on, and every test in this file shares one on-disk
// DB across setup() calls (same pattern as automations.test.ts), so a fixed
// team_id would leak automations across otherwise-unrelated test cases.
async function setup() {
  const { app, repo } = await loadApp();
  const n = ++seq;
  const domain = `sa${n}.example`;
  const session = await magic(app, `pat@${domain}`);
  const wsId = (await call(app, 'POST', '/workspaces', { token: session, body: { profile_id: 'notes', name: 'PatFolder' } })).json.id;
  const teamId = `T0SA${n}`;
  const slackId = `U0PAT${n}`;
  await call(app, 'PUT', '/me/identities/slack', {
    token: session,
    body: { team_id: teamId, external_id: slackId, handle: `pat${n}` },
  });
  return { app, repo, wsId, session, teamId, slackId };
}

describe('surface automations (slack listen) HTTP surface', () => {
  it('rejects every route without the correct shared secret', async () => {
    const { app, teamId } = await setup();
    const due = await call(app, 'GET', `/agent/surface/automations/due?team_id=${teamId}`);
    expect(due.status).toBe(401);
    const upsert = await call(app, 'POST', '/agent/surface/automations/upsert', {
      body: { team_id: teamId, slack_user_id: 'x', channel_id: 'C1', cadence_ms: 1000 },
    });
    expect(upsert.status).toBe(401);
  });

  it('upsert creates a slack_listen automation, visible via the shared workspace-scoped GET /automations', async () => {
    const { app, wsId, teamId, slackId } = await setup();
    const CADENCE = 12 * 60 * 60 * 1000;
    const r = await call(app, 'POST', '/agent/surface/automations/upsert', {
      surfaceSecret: 'shh-relay',
      body: { team_id: teamId, slack_user_id: slackId, channel_id: 'C123', cadence_ms: CADENCE },
    });
    expect(r.status).toBe(200);
    expect(r.json.created).toBe(true);
    expect(r.json.automation.kind).toBe('slack_listen');
    expect(r.json.automation.slack_channel_id).toBe('C123');
    expect(r.json.automation.cadence_ms).toBe(CADENCE);

    // Re-issuing `listen` for the same channel updates in place (idempotent),
    // not a second row — mirrors the old SubscriptionStore.upsert.
    const r2 = await call(app, 'POST', '/agent/surface/automations/upsert', {
      surfaceSecret: 'shh-relay',
      body: { team_id: teamId, slack_user_id: slackId, channel_id: 'C123', cadence_ms: 60 * 60 * 1000 },
    });
    expect(r2.json.created).toBe(false);
    expect(r2.json.automation.id).toBe(r.json.automation.id);
    expect(r2.json.automation.cadence_ms).toBe(60 * 60 * 1000);
  });

  it('GET .../due filters by team_id and only returns automations at/past next_run_at', async () => {
    const { app, teamId, slackId } = await setup();
    await call(app, 'POST', '/agent/surface/automations/upsert', {
      surfaceSecret: 'shh-relay',
      // 1ms cadence so it's immediately due.
      body: { team_id: teamId, slack_user_id: slackId, channel_id: 'C-due', cadence_ms: 1 },
    });
    // A different team's due row must never leak into this team's due list.
    const other = await setup();
    await call(other.app, 'POST', '/agent/surface/automations/upsert', {
      surfaceSecret: 'shh-relay',
      body: { team_id: other.teamId, slack_user_id: other.slackId, channel_id: 'C-other', cadence_ms: 1 },
    });

    await new Promise((r) => setTimeout(r, 5));
    const due = await call(app, 'GET', `/agent/surface/automations/due?team_id=${teamId}`, { surfaceSecret: 'shh-relay' });
    expect(due.status).toBe(200);
    expect(due.json.automations).toHaveLength(1);
    expect(due.json.automations[0].slack_channel_id).toBe('C-due');
  });

  it('report-run advances the schedule + watermark on success and records a run', async () => {
    const { app, wsId, session, teamId, slackId } = await setup();
    const created = await call(app, 'POST', '/agent/surface/automations/upsert', {
      surfaceSecret: 'shh-relay',
      body: { team_id: teamId, slack_user_id: slackId, channel_id: 'C-ok', cadence_ms: 60 * 60 * 1000 },
    });
    const id = created.json.automation.id as string;

    const report = await call(app, 'POST', `/agent/surface/automations/${id}/report-run`, {
      surfaceSecret: 'shh-relay',
      body: {
        team_id: teamId,
        slack_user_id: slackId,
        outcome: 'ok',
        window_to: '1700000000.000000',
        items_seen: 5,
        items_ingested: 1,
        document_ids: ['doc_1'],
      },
    });
    expect(report.status).toBe(200);
    expect(report.json.run.outcome).toBe('ok');
    expect(report.json.run.document_ids).toEqual(['doc_1']);

    // Visible via the normal workspace-scoped route, same as any other
    // automation — this is the whole point of the migration.
    const list = await call(app, 'GET', `/workspaces/${wsId}/automations?kind=slack_listen`, { token: session });
    const updated = list.json.automations.find((a: any) => a.id === id);
    expect(updated.watermark).toBe('1700000000.000000');
    expect(updated.fail_count).toBe(0);

    const runs = await call(app, 'GET', `/workspaces/${wsId}/automations/${id}/runs`, { token: session });
    expect(runs.json.runs).toHaveLength(1);
    expect(runs.json.runs[0].outcome).toBe('ok');
  });

  it('report-run backs off without advancing the watermark on error', async () => {
    const { app, teamId, slackId } = await setup();
    const created = await call(app, 'POST', '/agent/surface/automations/upsert', {
      surfaceSecret: 'shh-relay',
      body: { team_id: teamId, slack_user_id: slackId, channel_id: 'C-err', cadence_ms: 60 * 60 * 1000 },
    });
    const id = created.json.automation.id as string;

    const report = await call(app, 'POST', `/agent/surface/automations/${id}/report-run`, {
      surfaceSecret: 'shh-relay',
      body: { team_id: teamId, slack_user_id: slackId, outcome: 'error', error: 'conversations.history failed' },
    });
    expect(report.status).toBe(200);
    expect(report.json.run.outcome).toBe('error');
    expect(report.json.run.error).toContain('conversations.history failed');

    const due = await call(app, 'GET', `/agent/surface/automations/due?team_id=${teamId}`, { surfaceSecret: 'shh-relay' });
    // Backed off (1h cap) rather than due again immediately.
    expect(due.json.automations.find((a: any) => a.id === id)).toBeUndefined();
  });

  it('delete removes the automation so it no longer appears', async () => {
    const { app, teamId, slackId } = await setup();
    const created = await call(app, 'POST', '/agent/surface/automations/upsert', {
      surfaceSecret: 'shh-relay',
      body: { team_id: teamId, slack_user_id: slackId, channel_id: 'C-del', cadence_ms: 1 },
    });
    const del = await call(
      app,
      'DELETE',
      `/agent/surface/automations/slack-listen?team_id=${teamId}&slack_user_id=${slackId}&channel_id=C-del`,
      { surfaceSecret: 'shh-relay' },
    );
    expect(del.status).toBe(200);
    expect(del.json.removed).toBe(true);

    await new Promise((r) => setTimeout(r, 5));
    const due = await call(app, 'GET', `/agent/surface/automations/due?team_id=${teamId}`, { surfaceSecret: 'shh-relay' });
    expect(due.json.automations).toEqual([]);
    expect(created.status).toBe(200);
  });
});

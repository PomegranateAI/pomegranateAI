import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { foundingProfile } from '../../lib/profiles/__fixtures__/founding.js';

// Deterministic synth stub (server.js pulls the provider transitively).
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

// Stub ONLY the LLM loop; executeRegistryTool (used by /actions) stays real.
// The stub echoes what it received so the route's thread plumbing is visible.
const agentCalls: any[] = [];
vi.mock('./surface-agent.js', async () => {
  const real = await vi.importActual<typeof import('./surface-agent.js')>('./surface-agent.js');
  return {
    ...real,
    runSurfaceAgent: vi.fn(async (params: any) => {
      agentCalls.push(params);
      if (params.user_message === 'trigger held route') {
        return {
          message: 'Done.',
          receipts: [{
            tool: 'ingest_document',
            args: {},
            ok: true,
            result: {
              pending_approval: true,
              pending_route_id: 'pr_test',
              pending_route: { ask_user: 'Should I file this in Product?' },
            },
          }],
          pending_action: null,
        };
      }
      return {
        message: `echo:${params.user_message} (history=${params.history.length})`,
        receipts: [],
        pending_action: null, // confirm-first removed: the agent never arms one
      };
    }),
  };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-sroute-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
  process.env.SURFACE_AGENT_SECRET = 'shh-relay';
});

async function loadApp() {
  return import('../api/server.js?sroute=' + Date.now());
}

async function magic(app: any, email: string): Promise<string> {
  const r1 = await app.request('/auth/magic-link', {
    method: 'POST',
    body: JSON.stringify({ email }),
    headers: { 'content-type': 'application/json' },
  });
  const { dev_code } = await r1.json();
  const r2 = await app.request('/auth/exchange', {
    method: 'POST',
    body: JSON.stringify({ code: dev_code }),
    headers: { 'content-type': 'application/json' },
  });
  return (await r2.json()).session as string;
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
  const r = await app.request(url, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

let seq = 0;
/** One user with a linked Slack identity and a single folder. */
async function setup() {
  const mod = await loadApp();
  const { app, repo } = mod;
  const domain = `sr${++seq}.example`;
  const session = await magic(app, `pat@${domain}`);
  const wsId = (
    await call(app, 'POST', '/workspaces', { token: session, body: { profile_id: 'notes', name: 'PatFolder' } })
  ).json.id;
  await call(app, 'PUT', '/me/identities/slack', {
    token: session,
    body: { team_id: 'T0SR', external_id: `U0PAT${seq}`, handle: `pat${seq}` },
  });
  const patId = (await repo.findUserByEmail(`pat@${domain}`))!.id;
  return { app, repo, session, wsId, patId, slackId: `U0PAT${seq}`, domain };
}

function msgBody(slackId: string, text: string, threadKey = 'C1:111.1') {
  return {
    surface: 'slack',
    team_id: 'T0SR',
    slack_user_id: slackId,
    channel_id: 'C1',
    thread_key: threadKey,
    text,
  };
}

describe('POST /agent/surface/messages', () => {
  it('persists the caller\'s own nickname and gives it to the surface agent', async () => {
    const { app, session, slackId } = await setup();
    const saved = await call(app, 'PATCH', '/me', {
      token: session,
      body: { assistant_nickname: 'Mango' },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.assistant_nickname).toBe('Mango');
    expect((await call(app, 'GET', '/me', { token: session })).json.assistant_nickname).toBe('Mango');

    const r = await call(app, 'POST', '/agent/surface/messages', {
      body: msgBody(slackId, 'Mango, show my goals', 'C1:nickname'),
      surfaceSecret: 'shh-relay',
    });
    expect(r.status).toBe(200);
    expect(r.json.assistant_nickname).toBe('Mango');
    expect(agentCalls.at(-1).assistant_nickname).toBe('Mango');
  });

  it('accepts a Unicode nickname, rejects punctuation-only, and clears on empty', async () => {
    const { app, session } = await setup();
    const valid = await call(app, 'PATCH', '/me', {
      token: session,
      body: { assistant_nickname: 'رمان' },
    });
    expect(valid.status).toBe(200);
    expect(valid.json.assistant_nickname).toBe('رمان');
    expect((await call(app, 'PATCH', '/me', {
      token: session,
      body: { assistant_nickname: '@@' },
    })).status).toBe(400);
    // Clearing the nickname must not clobber the display name set alongside it.
    await call(app, 'PATCH', '/me', { token: session, body: { display_name: 'Ada' } });
    const cleared = await call(app, 'PATCH', '/me', { token: session, body: { assistant_nickname: '' } });
    expect(cleared.json.assistant_nickname).toBeNull();
    expect(cleared.json.display_name).toBe('Ada');
  });

  it('rejects a missing or wrong relay secret', async () => {
    const { app, slackId } = await setup();
    expect((await call(app, 'POST', '/agent/surface/messages', { body: msgBody(slackId, 'hi') })).status).toBe(401);
    expect(
      (
        await call(app, 'POST', '/agent/surface/messages', {
          body: msgBody(slackId, 'hi'),
          surfaceSecret: 'wrong',
        })
      ).status,
    ).toBe(401);
  });

  it('an unmapped slack user gets a friendly link-your-profile reply', async () => {
    const { app } = await setup();
    const r = await call(app, 'POST', '/agent/surface/messages', {
      body: msgBody('U0NOBODY', 'hi'),
      surfaceSecret: 'shh-relay',
    });
    expect(r.status).toBe(200);
    expect(r.json.unmapped).toBe(true);
    expect(r.json.reply).toContain('link your Slack');
  });

  it('multiple folders + no default → runs in the folder of last activity', async () => {
    const { app, session, slackId } = await setup();
    // Creating SecondFolder is pat's most recent recorded activity.
    const ws2 = (
      await call(app, 'POST', '/workspaces', { token: session, body: { profile_id: 'notes', name: 'SecondFolder' } })
    ).json.id;
    const r = await call(app, 'POST', '/agent/surface/messages', {
      body: msgBody(slackId, 'hi', 'C1:222.1'),
      surfaceSecret: 'shh-relay',
    });
    expect(r.status).toBe(200);
    expect(r.json.needs_default).toBeUndefined();
    expect(r.json.folder.id).toBe(ws2);
  });

  it('multiple folders, no default, and no recorded activity → asks to pick a default in Setup', async () => {
    const { app, session, slackId, wsId, domain } = await setup();
    // Mia never acts herself: she is ADDED to two folders by pat, signs in,
    // and links Slack — none of which counts as folder activity of hers.
    const miaEmail = `mia@${domain}`;
    const mia = await magic(app, miaEmail);
    const ws2 = (
      await call(app, 'POST', '/workspaces', { token: session, body: { profile_id: 'notes', name: 'SecondFolder' } })
    ).json.id;
    await call(app, 'POST', `/workspaces/${wsId}/members`, {
      token: session,
      body: { email: miaEmail, role: 'member' },
    });
    await call(app, 'POST', `/workspaces/${ws2}/members`, {
      token: session,
      body: { email: miaEmail, role: 'member' },
    });
    const miaSlack = slackId.replace('PAT', 'MIA');
    await call(app, 'PUT', '/me/identities/slack', {
      token: mia,
      body: { team_id: 'T0SR', external_id: miaSlack, handle: `mia-${domain}` },
    });
    const r = await call(app, 'POST', '/agent/surface/messages', {
      body: msgBody(miaSlack, 'hi', 'C1:333.1'),
      surfaceSecret: 'shh-relay',
    });
    expect(r.status).toBe(200);
    expect(r.json.needs_default).toBe(true);
  });

  it('runs the agent in the resolved folder and persists the thread + history', async () => {
    const { app, repo, slackId, wsId, patId } = await setup();
    const r1 = await call(app, 'POST', '/agent/surface/messages', {
      body: msgBody(slackId, 'please accept the roadmap source'),
      surfaceSecret: 'shh-relay',
    });
    expect(r1.status).toBe(200);
    expect(r1.json.reply).toContain('history=0');
    expect(r1.json.folder.id).toBe(wsId);
    // Confirm-first is gone: no pending confirmation, no truth-footer.
    expect(r1.json.pending_confirmation).toBeUndefined();
    expect(r1.json.reply).not.toContain('Nothing has been changed yet');

    // Thread rows persisted: user + agent messages; never a pending action.
    const thread = await repo.getAgentThread('slack', 'T0SR', 'C1:111.1');
    expect(thread?.user_id).toBe(patId);
    expect(thread?.workspace_id).toBe(wsId);
    expect(thread?.pending_action).toBeNull();

    // Second turn: prior turn's messages flow back as history.
    const r2 = await call(app, 'POST', '/agent/surface/messages', {
      body: msgBody(slackId, 'yes'),
      surfaceSecret: 'shh-relay',
    });
    expect(r2.json.reply).toContain('history=2');
    expect((await repo.getAgentThread('slack', 'T0SR', 'C1:111.1'))?.pending_action).toBeNull();

    // The turn is customer-audited against the folder.
    const audit = repo.db
      .prepare(`SELECT COUNT(*) AS n FROM customer_audit_log WHERE event = 'surface_agent_used'`)
      .get() as { n: number };
    expect(audit.n).toBeGreaterThanOrEqual(2);
  });
});

describe('POST /agent/surface/actions', () => {
  it('whitelists tools and executes ingest_document end-to-end', async () => {
    const { app, repo, session, slackId, wsId } = await setup();
    // The stub's capture heuristics extract a decision-kind candidate from
    // "killing" — install the founding fixture profile so it validates.
    await call(app, 'PUT', `/workspaces/${wsId}/profile`, { token: session, body: { profile: foundingProfile } });

    // Not on the whitelist → 400. (accept_source/accept_candidate/etc. were
    // curation-queue tools removed with the routing-approval pivot; the
    // surface whitelist no longer names them either.)
    const denied = await call(app, 'POST', '/agent/surface/actions', {
      surfaceSecret: 'shh-relay',
      body: { surface: 'slack', team_id: 'T0SR', slack_user_id: slackId, tool: 'accept_source', args: {} },
    });
    expect(denied.status).toBe(400);

    // A whitelisted tool executes end-to-end via the click/schedule action
    // route (no interceptor — the click IS the confirmation).
    const ran = await call(app, 'POST', '/agent/surface/actions', {
      surfaceSecret: 'shh-relay',
      body: {
        surface: 'slack',
        team_id: 'T0SR',
        slack_user_id: slackId,
        tool: 'ingest_document',
        args: { source: 'We are killing the legacy importer from the button.', source_kind: 'doc', source_ref: 'btn-test' },
      },
    });
    expect(ran.status).toBe(200);
    expect(ran.json.ok).toBe(true);
    expect(ran.json.result.candidates).toBeGreaterThan(0);

    // Light auto-applies on ingest — the node is already active in the folder.
    const graph = await repo.listNodesWithEmbeddings(wsId, { activeOnly: true });
    expect(graph.some((r) => r.node.body?.includes('killing the legacy importer'))).toBe(true);
  });

  it('an unmapped clicker is a 404 with the link-profile reply', async () => {
    const { app } = await setup();
    const r = await call(app, 'POST', '/agent/surface/actions', {
      surfaceSecret: 'shh-relay',
      body: { surface: 'slack', team_id: 'T0SR', slack_user_id: 'U0GHOST', tool: 'ingest_document', args: { source: 'x' } },
    });
    expect(r.status).toBe(404);
  });
});

// ---- WhatsApp Surface Routing Tests ----
describe('POST /agent/surface/messages [WhatsApp]', () => {
  let seqWA = 0;

  async function setupWhatsApp() {
    const mod = await loadApp();
    const { app, repo } = mod;
    const domain = `wa${++seqWA}.example`;
    const session = await magic(app, `pat@${domain}`);
    const wsId = (
      await call(app, 'POST', '/workspaces', { token: session, body: { profile_id: 'notes', name: 'PatWAFolder' } })
    ).json.id;
    await call(app, 'PUT', '/me/identities/whatsapp', {
      token: session,
      body: { phone: '+1 234 567 8900' },
    });
    const patId = (await repo.findUserByEmail(`pat@${domain}`))!.id;
    return { app, repo, session, wsId, patId, phone: '12345678900', domain };
  }

  function whatsappMsgBody(phone: string, text: string, threadKey?: string) {
    return {
      surface: 'whatsapp',
      phone,
      thread_key: threadKey || phone,
      text,
    };
  }

  it('rejects missing or wrong relay secret', async () => {
    const { app, phone } = await setupWhatsApp();
    expect((await call(app, 'POST', '/agent/surface/messages', { body: whatsappMsgBody(phone, 'hi') })).status).toBe(401);
    expect(
      (
        await call(app, 'POST', '/agent/surface/messages', {
          body: whatsappMsgBody(phone, 'hi'),
          surfaceSecret: 'wrong',
        })
      ).status,
    ).toBe(401);
  });

  it('an unmapped phone number gets a friendly link-profile reply', async () => {
    const { app } = await setupWhatsApp();
    const r = await call(app, 'POST', '/agent/surface/messages', {
      body: whatsappMsgBody('9999999999', 'hi'),
      surfaceSecret: 'shh-relay',
    });
    expect(r.status).toBe(200);
    expect(r.json.unmapped).toBe(true);
    expect(r.json.reply).toContain('link this WhatsApp number');
  });

  it('successfully processes a message and routes to a folder', async () => {
    const { app, phone } = await setupWhatsApp();
    const r = await call(app, 'POST', '/agent/surface/messages', {
      body: whatsappMsgBody(phone, 'hello'),
      surfaceSecret: 'shh-relay',
    });
    expect(r.status).toBe(200);
    expect(r.json.reply).toBeDefined();
    expect(r.json.folder).toBeDefined();
  });

  it('forces and restores a held routing decision on WhatsApp', async () => {
    const { app, repo, phone } = await setupWhatsApp();
    const threadKey = `${phone}:held`;
    const held = await call(app, 'POST', '/agent/surface/messages', {
      body: whatsappMsgBody(phone, 'trigger held route', threadKey),
      surfaceSecret: 'shh-relay',
    });
    expect(held.json.reply).toBe('Should I file this in Product?');
    expect((await repo.getAgentThread('whatsapp', 'whatsapp', threadKey))?.pending_action).toMatchObject({
      tool: 'resolve_pending_route',
      args: { id: 'pr_test' },
    });

    await call(app, 'POST', '/agent/surface/messages', {
      body: whatsappMsgBody(phone, 'approve it', threadKey),
      surfaceSecret: 'shh-relay',
    });
    expect(agentCalls.at(-1)?.pending_action).toMatchObject({ args: { id: 'pr_test' } });
  });

  it('multiple folders, no default, and no recorded activity → asks to pick a default in Setup', async () => {
    const { app, session, wsId, domain } = await setupWhatsApp();
    // mia2 never acts herself: she is ADDED to two folders by pat, signs in,
    // and links WhatsApp — none of which counts as folder activity of hers.
    const mia2Email = `mia2@${domain}`;
    const mia2 = await magic(app, mia2Email);
    const ws2 = (
      await call(app, 'POST', '/workspaces', { token: session, body: { profile_id: 'notes', name: 'ThirdWAFolder' } })
    ).json.id;
    await call(app, 'POST', `/workspaces/${wsId}/members`, {
      token: session,
      body: { email: mia2Email, role: 'member' },
    });
    await call(app, 'POST', `/workspaces/${ws2}/members`, {
      token: session,
      body: { email: mia2Email, role: 'member' },
    });
    await call(app, 'PUT', '/me/identities/whatsapp', {
      token: mia2,
      body: { phone: '+1 555 666 7777' },
    });
    const r = await call(app, 'POST', '/agent/surface/messages', {
      body: whatsappMsgBody('15556667777', 'hi', 'C3:333.1'),
      surfaceSecret: 'shh-relay',
    });
    expect(r.status).toBe(200);
    expect(r.json.needs_default).toBe(true);
  });

  it('runs the agent in the resolved folder and persists the thread + history', async () => {
    const { app, repo, session, phone, wsId, patId } = await setupWhatsApp();
    // Set explicit WhatsApp default to ensure routing.
    await call(app, 'PUT', '/me/defaults/whatsapp', {
      token: session,
      body: { workspace_id: wsId },
    });

    // Use a unique thread key to avoid collision with other tests.
    const uniqueThreadKey = `${phone}:thread1`;

    const r1 = await call(app, 'POST', '/agent/surface/messages', {
      body: whatsappMsgBody(phone, 'first message', uniqueThreadKey),
      surfaceSecret: 'shh-relay',
    });
    expect(r1.status).toBe(200);
    expect(r1.json.reply).toContain('history=0');
    expect(r1.json.filed_to).toEqual([]);

    // Thread rows persisted: user + agent messages.
    const thread = await repo.getAgentThread('whatsapp', 'whatsapp', uniqueThreadKey);
    expect(thread).toBeDefined();
    expect(thread?.user_id).toBeDefined();
    expect(thread?.pending_action).toBeNull();

    // Second turn: prior turn's messages flow back as history.
    const r2 = await call(app, 'POST', '/agent/surface/messages', {
      body: whatsappMsgBody(phone, 'second message', uniqueThreadKey),
      surfaceSecret: 'shh-relay',
    });
    expect(r2.status).toBe(200);
    expect(r2.json.reply).toContain('history=2');
    expect((await repo.getAgentThread('whatsapp', 'whatsapp', uniqueThreadKey))?.pending_action).toBeNull();

    // The turn is customer-audited against the folder.
    const audit = repo.db
      .prepare(`SELECT COUNT(*) AS n FROM customer_audit_log WHERE event = 'surface_agent_used'`)
      .get() as { n: number };
    expect(audit.n).toBeGreaterThanOrEqual(2);
  });

  it('phone number normalization handles various formats', async () => {
    // Test that phone normalization is consistent with how the DB stores it.
    const { app, repo, session, wsId, domain } = await setupWhatsApp();
    const userEmail = `norm@${domain}`;
    const normSession = await magic(app, userEmail);

    // Link a phone with formatting, which should be normalized.
    await call(app, 'PUT', '/me/identities/whatsapp', {
      token: normSession,
      body: { phone: '+1 (456) 789-0123' },
    });

    // Send message with just digits - should match the normalized stored value.
    const r = await call(app, 'POST', '/agent/surface/messages', {
      body: whatsappMsgBody('14567890123', 'test message'),
      surfaceSecret: 'shh-relay',
    });
    expect(r.status).toBe(200);
    // Should get needs_default since this user has no default folder set
    expect(r.json.needs_default).toBe(true);
  });
});

describe('POST /agent/surface/actions [WhatsApp]', () => {
  let seqWAAction = 0;

  async function setupWhatsAppAction() {
    const mod = await loadApp();
    const { app, repo } = mod;
    const domain = `waact${++seqWAAction}.example`;
    const session = await magic(app, `pat@${domain}`);
    const wsId = (
      await call(app, 'POST', '/workspaces', { token: session, body: { profile_id: 'notes', name: 'PatWAActionFolder' } })
    ).json.id;
    await call(app, 'PUT', `/workspaces/${wsId}/profile`, { token: session, body: { profile: foundingProfile } });
    await call(app, 'PUT', '/me/identities/whatsapp', {
      token: session,
      body: { phone: '+1 888 999 0000' },
    });
    const patId = (await repo.findUserByEmail(`pat@${domain}`))!.id;
    return { app, repo, session, wsId, patId, phone: '18889990000', domain };
  }

  it('whitelisted tools execute end-to-end via WhatsApp', async () => {
    const { app, wsId, phone } = await setupWhatsAppAction();
    const ran = await call(app, 'POST', '/agent/surface/actions', {
      surfaceSecret: 'shh-relay',
      body: {
        surface: 'whatsapp',
        phone,
        tool: 'ingest_document',
        args: { source: 'Killing the legacy WhatsApp importer.', source_kind: 'doc', source_ref: 'btn-test-wa' },
      },
    });
    expect(ran.status).toBe(200);
    expect(ran.json.ok).toBe(true);
    expect(ran.json.result.candidates).toBeGreaterThan(0);
  });

  it('an unmapped WhatsApp number is a 404 with the link-profile reply', async () => {
    const { app } = await setupWhatsAppAction();
    const r = await call(app, 'POST', '/agent/surface/actions', {
      surfaceSecret: 'shh-relay',
      body: {
        surface: 'whatsapp',
        phone: '9999999999',
        tool: 'ingest_document',
        args: { source: 'x' },
      },
    });
    expect(r.status).toBe(404);
  });

  it('WhatsApp action respects surface-level tool whitelist', async () => {
    const { app, phone } = await setupWhatsAppAction();
    // Disallowed tool → 400.
    const denied = await call(app, 'POST', '/agent/surface/actions', {
      surfaceSecret: 'shh-relay',
      body: { surface: 'whatsapp', phone, tool: 'accept_source', args: {} },
    });
    expect(denied.status).toBe(400);
  });
});

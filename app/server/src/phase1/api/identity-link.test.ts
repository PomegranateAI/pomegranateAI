import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseLinkCode, mintLinkCode } from './identity-link.js';

// Deterministic synth stub (server.js pulls the provider transitively).
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

// Stub the LLM loop: a linked sender's ordinary message reaches it.
const agentCalls: any[] = [];
vi.mock('../agent/surface-agent.js', async () => {
  const real = await vi.importActual<typeof import('../agent/surface-agent.js')>('../agent/surface-agent.js');
  return {
    ...real,
    runSurfaceAgent: vi.fn(async (params: any) => {
      agentCalls.push(params);
      return { message: `echo:${params.user_message}`, receipts: [], pending_action: null };
    }),
  };
});

const SECRET = 'shh-link';

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-idlink-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
  process.env.SURFACE_AGENT_SECRET = SECRET;
  delete process.env.POMEGRANATE_ALLOW_UNVERIFIED_IDENTITY_LINK;
  // Warm the module graph once so the first test isn't charged the cold import.
  await import('./server.js');
}, 180_000);

async function loadApp() {
  return import('./server.js?idlink=' + Date.now());
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

async function call(app: any, method: string, url: string, opts: { token?: string; body?: unknown; surface?: boolean } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.surface) headers['x-surface-secret'] = SECRET;
  const r = await app.request(url, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

let seq = 0;
async function setup() {
  const { app, repo } = await loadApp();
  const n = ++seq;
  const email = `ana@link${n}.example`;
  const session = await magic(app, email);
  await call(app, 'POST', '/workspaces', { token: session, body: { profile_id: 'notes', name: `AnaFolder${n}` } });
  return { app, repo, session, email, n };
}

const slackMsg = (user: string, text: string, channel = 'D0DM') => ({
  surface: 'slack',
  team_id: 'T0LINK',
  slack_user_id: user,
  channel_id: channel,
  thread_key: channel,
  text,
});
const waMsg = (phone: string, text: string, extra: Record<string, unknown> = {}) => ({
  surface: 'whatsapp',
  phone,
  thread_key: phone,
  text,
  ...extra,
});

async function mint(app: any, session: string, kind: 'slack' | 'whatsapp') {
  const r = await call(app, 'POST', `/me/identities/${kind}/link-code`, { token: session });
  expect(r.status).toBe(200);
  return r.json as { code: string; expires_at: string; instructions: string };
}

describe('link code format', () => {
  it('mints PMG- plus 6 unambiguous characters and parses tolerant input', () => {
    const code = mintLinkCode();
    expect(code).toMatch(/^PMG-[A-HJKMNP-Z2-9]{6}$/);
    expect(parseLinkCode(`  ${code.toLowerCase()} `)).toBe(code);
    expect(parseLinkCode(`link ${code}`)).toBe(code);
    expect(parseLinkCode(`\`${code}\``)).toBe(code);
    expect(parseLinkCode(`please link ${code}`)).toBeNull();
    expect(parseLinkCode('PMG-ABC')).toBeNull();
    expect(parseLinkCode('hello')).toBeNull();
  });
});

describe('PUT /me/identities/* gating', () => {
  it('an unverified PUT is refused with 403 verification_required', async () => {
    const { app, session } = await setup();
    const s = await call(app, 'PUT', '/me/identities/slack', { token: session, body: { team_id: 'T0LINK', external_id: 'U0VICTIM' } });
    expect(s.status).toBe(403);
    expect(s.json).toEqual({ error: 'verification_required', detail: 'use a link code' });
    const w = await call(app, 'PUT', '/me/identities/whatsapp', { token: session, body: { phone: '+1 555 000 0001' } });
    expect(w.status).toBe(403);
    expect((await call(app, 'GET', '/me', { token: session })).json.identities).toEqual([]);
  });

  it('works with POMEGRANATE_ALLOW_UNVERIFIED_IDENTITY_LINK=1', async () => {
    const { app, session } = await setup();
    vi.stubEnv('POMEGRANATE_ALLOW_UNVERIFIED_IDENTITY_LINK', '1');
    try {
      const s = await call(app, 'PUT', '/me/identities/slack', { token: session, body: { team_id: 'T0LINK', external_id: `U0DEV${seq}` } });
      expect(s.status).toBe(200);
      const w = await call(app, 'PUT', '/me/identities/whatsapp', { token: session, body: { phone: `+1 555 100 00${seq}` } });
      expect(w.status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a system admin can set identities, for themselves and via /admin/users/:id', async () => {
    const { app, repo, session } = await setup();
    const admin = (await repo.findUserByEmail(`ana@link${seq}.example`))!;
    await repo.sql.exec('UPDATE users SET is_admin = 1 WHERE id = ?', [admin.id]);
    const self = await call(app, 'PUT', '/me/identities/slack', { token: session, body: { team_id: 'T0LINK', external_id: `U0ADM${seq}` } });
    expect(self.status).toBe(200);
    const otherSession = await magic(app, `bob@link${seq}.example`);
    const bob = (await repo.findUserByEmail(`bob@link${seq}.example`))!;
    const r = await call(app, 'PUT', `/admin/users/${bob.id}/identities/whatsapp`, { token: session, body: { phone: '+44 20 7946 0000' } });
    expect(r.status).toBe(200);
    expect(r.json.identity.external_id).toBe('442079460000');
    // A non-admin can't use the admin route.
    const denied = await call(app, 'PUT', `/admin/users/${admin.id}/identities/slack`, { token: otherSession, body: { external_id: 'U0X' } });
    expect(denied.status).toBe(403);
  });
});

describe('link code → surface relay redemption', () => {
  it('mint → redeem from Slack links the sender; the second use fails; then messages route', async () => {
    const { app, session, email, n } = await setup();
    const { code, expires_at, instructions } = await mint(app, session, 'slack');
    expect(code).toMatch(/^PMG-/);
    expect(Date.parse(expires_at) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(instructions).toContain(code);

    const slackUser = `U0ANA${n}`;
    const r = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg(slackUser, `link ${code.toLowerCase()}`) });
    expect(r.status).toBe(200);
    expect(r.json.reply).toBe(`Linked this Slack account to ${email}. You can now message me.`);
    const me = (await call(app, 'GET', '/me', { token: session })).json;
    expect(me.identities).toEqual([expect.objectContaining({ kind: 'slack', team_id: 'T0LINK', external_id: slackUser })]);

    // Same code again, from a different unlinked sender: spent.
    const again = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg(`U0EVE${n}`, code) });
    expect(again.json.reply).toContain("isn't valid or has expired");
    expect(again.json.reply).not.toContain(email);
    expect(again.json.unmapped).toBe(true);

    // The linked sender now reaches the agent.
    const hi = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg(slackUser, 'hi') });
    expect(hi.json.reply).toBe('echo:hi');
  });

  it('mint → redeem from WhatsApp links the phone number', async () => {
    const { app, session, email, n } = await setup();
    const { code } = await mint(app, session, 'whatsapp');
    const phone = `1415555${String(n).padStart(4, '0')}`;
    const r = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: waMsg(`+${phone}`, code) });
    expect(r.json.reply).toBe(`Linked this WhatsApp number to ${email}. You can now message me.`);
    const me = (await call(app, 'GET', '/me', { token: session })).json;
    expect(me.identities).toEqual([expect.objectContaining({ kind: 'whatsapp', external_id: phone })]);
  });

  it('requires the relay secret', async () => {
    const { app, session } = await setup();
    const { code } = await mint(app, session, 'slack');
    const r = await call(app, 'POST', '/agent/surface/messages', { body: slackMsg('U0NOSECRET', code) });
    expect(r.status).toBe(401);
  });

  it('an expired code fails', async () => {
    const { app, repo, session, n } = await setup();
    const { code } = await mint(app, session, 'slack');
    await repo.sql.exec('UPDATE identity_link_codes SET expires_at = ?', [new Date(Date.now() - 1000).toISOString()]);
    const r = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg(`U0EXP${n}`, code) });
    expect(r.json.reply).toContain("isn't valid or has expired");
    expect((await call(app, 'GET', '/me', { token: session })).json.identities).toEqual([]);
  });

  it('a code of the wrong kind fails', async () => {
    const { app, session, n } = await setup();
    const { code } = await mint(app, session, 'whatsapp');
    const r = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg(`U0WRONG${n}`, code) });
    expect(r.json.reply).toContain("isn't valid or has expired");
    expect((await call(app, 'GET', '/me', { token: session })).json.identities).toEqual([]);
  });

  it('an already-mapped sender is refused and the code is not used up', async () => {
    const { app, session, n } = await setup();
    // Bob links his Slack account with his own code.
    const bobSession = await magic(app, `bob@link${n}.example`);
    const bobCode = (await mint(app, bobSession, 'slack')).code;
    const bobSlack = `U0BOB${n}`;
    await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg(bobSlack, bobCode) });

    // Ana's code sent from Bob's (already-linked) account is refused.
    const { code } = await mint(app, session, 'slack');
    const r = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg(bobSlack, code) });
    expect(r.json.reply).toContain('already linked to a Pomegranate account');
    expect(r.json.reply).toContain('unlink it in the web app first');
    expect(r.json.reply).not.toContain('ana@');
    expect((await call(app, 'GET', '/me', { token: session })).json.identities).toEqual([]);

    // After Bob unlinks, the same code from his account links it to Ana.
    expect((await call(app, 'DELETE', '/me/identities/slack', { token: bobSession })).json.removed).toBe(1);
    const linked = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg(bobSlack, code) });
    expect(linked.json.reply).toContain('Linked this Slack account to ana@');
  });

  it('minting a new code invalidates the old one', async () => {
    const { app, session, n } = await setup();
    const first = (await mint(app, session, 'slack')).code;
    const second = (await mint(app, session, 'slack')).code;
    const old = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg(`U0NEW${n}`, first) });
    expect(old.json.reply).toContain("isn't valid or has expired");
    const ok = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg(`U0NEW${n}`, second) });
    expect(ok.json.reply).toContain('Linked this Slack account');
  });

  it('a code posted in a channel or group is cancelled, not redeemed', async () => {
    const { app, session, n } = await setup();
    const { code } = await mint(app, session, 'slack');
    const r = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg(`U0CHAN${n}`, code, 'C0PUBLIC') });
    expect(r.json.reply).toContain('only work in a direct message');
    const dm = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg(`U0CHAN${n}`, code) });
    expect(dm.json.reply).toContain("isn't valid or has expired");

    const wa = (await mint(app, session, 'whatsapp')).code;
    const g = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: waMsg('15550009999', wa, { is_group: true }) });
    expect(g.json.reply).toContain('only work in a direct message');
    expect((await call(app, 'GET', '/me', { token: session })).json.identities).toEqual([]);
  });

  it('rate-limits redemption failures per sender', async () => {
    const { app, session, n } = await setup();
    const sender = `U0BRUTE${n}`;
    for (let i = 0; i < 5; i++) {
      const r = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg(sender, `PMG-AAAAA${'23456'[i]}`) });
      expect(r.json.reply).toContain("isn't valid");
    }
    // Even a valid code is now refused for this sender.
    const { code } = await mint(app, session, 'slack');
    const r = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg(sender, code) });
    expect(r.json.reply).toContain('Too many link attempts');
    expect((await call(app, 'GET', '/me', { token: session })).json.identities).toEqual([]);
  });

  it('rate-limits minting to 10 per hour per user', async () => {
    const { app, session } = await setup();
    for (let i = 0; i < 10; i++) await mint(app, session, i % 2 ? 'slack' : 'whatsapp');
    const r = await call(app, 'POST', '/me/identities/slack/link-code', { token: session });
    expect(r.status).toBe(429);
  });

  it('the unmapped reply tells the person how to link', async () => {
    const { app } = await setup();
    const s = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: slackMsg('U0NOBODY', 'hi') });
    expect(s.json.unmapped).toBe(true);
    expect(s.json.reply).toContain('Setup → Your profile → Connect Slack, get a link code');
    const w = await call(app, 'POST', '/agent/surface/messages', { surface: true, body: waMsg('15550001111', 'hi') });
    expect(w.json.reply).toContain('Setup → Your profile → Connect WhatsApp, get a link code');
  });
});

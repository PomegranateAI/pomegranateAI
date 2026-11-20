import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';
import { Repo } from './repo.js';
import type { Node, ContextProfile } from '../../lib/schemas.js';

let db: Database.Database;
let repo: Repo;

const ts = '2026-01-01T00:00:00Z';

const sampleNode: Node = {
  id: 'pos-killed-allinone',
  type: 'positioning',
  created_at: ts,
  updated_at: ts,
  status: 'active',
  body: 'We are not the all-in-one revenue platform',
  kind: 'killed_messaging',
};

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
});

describe('workspace + user + membership', () => {
  it('creates a workspace and auto-creates owner + admin membership', async () => {
    const ws = await repo.createWorkspace({ name: 'Test', owner_email: 'cro@example.com' });
    expect(ws.id).toMatch(/^ws_/);
    const owner = await repo.findOrCreateUser('cro@example.com');
    const mem = await repo.getMembership(ws.id, owner.id);
    expect(mem?.role).toBe('workspace_admin');
  });

  it('idempotent user creation', async () => {
    const a = await repo.findOrCreateUser('x@y.com');
    const b = await repo.findOrCreateUser('x@y.com');
    expect(a.id).toBe(b.id);
  });
});

describe('node visibility / sharing (graph sync)', () => {
  async function setup() {
    const ws = await repo.createWorkspace({ name: 'Team', owner_email: 'owner@a.com' });
    const owner = await repo.findOrCreateUser('owner@a.com');
    const mate = await repo.findOrCreateUser('mate@a.com');
    await repo.addMember({ workspace_id: ws.id, user_id: mate.id, role: 'member' });
    const outsider = await repo.findOrCreateUser('outsider@a.com'); // not a member
    await repo.upsertNode(ws.id, sampleNode);
    return { ws, owner, mate, outsider, nodeId: sampleNode.id };
  }

  it('defaults a freshly-upserted node to team-visible with no owner (cloud behavior)', async () => {
    const { ws, nodeId, mate } = await setup();
    expect(await repo.getNodeVisibility(ws.id, nodeId)).toEqual({ visibility: 'team', owner_user_id: null });
    expect(await repo.nodeVisibleToViewer(ws.id, nodeId, mate.id)).toBe(true);
  });

  it('private ("AI agents") node is visible to its owner AND the owner\'s AI, not teammates', async () => {
    const { ws, nodeId, owner, mate } = await setup();
    await repo.setNodeVisibility(ws.id, nodeId, 'private', owner.id);
    expect(await repo.nodeVisibleToViewer(ws.id, nodeId, owner.id)).toBe(true);
    // The 'AI agents' tier: the owner's own agents CAN read it (aiRead true).
    expect(await repo.nodeVisibleToViewer(ws.id, nodeId, owner.id, true)).toBe(true);
    expect(await repo.nodeVisibleToViewer(ws.id, nodeId, mate.id)).toBe(false);
    expect(await repo.nodeVisibleToViewer(ws.id, nodeId, mate.id, true)).toBe(false);
  });

  it('owner_user_id is sticky once set (a teammate cannot re-own)', async () => {
    const { ws, nodeId, owner, mate } = await setup();
    await repo.setNodeVisibility(ws.id, nodeId, 'private', owner.id);
    await repo.setNodeVisibility(ws.id, nodeId, 'team', mate.id); // tries to re-own
    expect((await repo.getNodeVisibility(ws.id, nodeId))?.owner_user_id).toBe(owner.id);
  });

  it('only_me node is visible to its owner in the UI but hidden from ALL AI reads', async () => {
    const { ws, nodeId, owner, mate } = await setup();
    await repo.setNodeVisibility(ws.id, nodeId, 'only_me', owner.id);
    // Human/UI read: the owner sees it in the app; nobody else does.
    expect(await repo.nodeVisibleToViewer(ws.id, nodeId, owner.id)).toBe(true);
    expect(await repo.nodeVisibleToViewer(ws.id, nodeId, mate.id)).toBe(false);
    // AI read: hidden even from the owner's OWN agents — the point of the tier.
    expect(await repo.nodeVisibleToViewer(ws.id, nodeId, owner.id, true)).toBe(false);
    expect(await repo.nodeVisibleToViewer(ws.id, nodeId, mate.id, true)).toBe(false);
  });

  it('lists workspace members for the share picker', async () => {
    const { ws } = await setup();
    const emails = (await repo.listWorkspaceMembers(ws.id)).map((m) => m.email).sort();
    expect(emails).toEqual(['mate@a.com', 'owner@a.com']);
  });

  it('deleteSharedNode removes the node and its evidence', async () => {
    const { ws, nodeId, owner } = await setup();
    await repo.setNodeVisibility(ws.id, nodeId, 'private', owner.id);
    await repo.addNodeEvidence(ws.id, { node_id: nodeId, document_id: 'd1', quote: 'q' });
    await repo.deleteSharedNode(ws.id, nodeId);
    expect(await repo.getNode(ws.id, nodeId)).toBeUndefined();
    expect(await repo.listNodeEvidence(ws.id, nodeId)).toEqual([]);
  });

  it('use-phase redaction: non-owner viewers get the redacted copy, owner + local get full (§5.3c)', async () => {
    const { ws, owner, mate, nodeId } = await setup();
    await repo.setNodeVisibility(ws.id, nodeId, 'team', owner.id); // stamp the owner
    await repo.setNodeRedaction(ws.id, nodeId, JSON.stringify({ ...sampleNode, body: '[redacted]' }));

    const bodyFor = async (viewer?: string) =>
      (
        (await repo
          .listNodes(ws.id, { activeOnly: true, viewer }, 'default'))
          .find((x) => (x as { id: string }).id === nodeId) as { body?: string } | undefined
      )?.body;

    expect(await bodyFor(owner.id)).toBe(sampleNode.body); // owner sees full
    expect(await bodyFor(mate.id)).toBe('[redacted]'); // teammate sees redacted
    expect(await bodyFor(undefined)).toBe(sampleNode.body); // local single-user (no viewer) sees full

    // Clearing the redaction restores the full body for everyone.
    await repo.setNodeRedaction(ws.id, nodeId, null);
    expect(await bodyFor(mate.id)).toBe(sampleNode.body);
  });

  it('listNodes enforces viewer / teamOnly / aiRead filters', async () => {
    const { ws, owner, mate, outsider } = await setup(); // sampleNode = team (default)
    const priv: Node = { ...sampleNode, id: 'priv-1' };
    await repo.upsertNode(ws.id, priv);
    await repo.setNodeVisibility(ws.id, priv.id, 'private', owner.id);
    const onlyMe: Node = { ...sampleNode, id: 'onlyme-1' };
    await repo.upsertNode(ws.id, onlyMe);
    await repo.setNodeVisibility(ws.id, onlyMe.id, 'only_me', owner.id);

    const ids = async (opts: { viewer?: string; teamOnly?: boolean; aiRead?: boolean }) =>
      (await repo.listNodes(ws.id, { activeOnly: true, ...opts })).map((n) => n.id).sort();

    const all = ['priv-1', 'onlyme-1', sampleNode.id].sort();
    expect(await ids({})).toEqual(all); // no viewer = unfiltered (system reads)
    expect(await ids({ teamOnly: true })).toEqual([sampleNode.id]); // overview
    // Owner, human/UI read: own private + only_me + team.
    expect(await ids({ viewer: owner.id })).toEqual(all);
    // Owner, AI read: only_me excluded even for the owner; private kept.
    expect(await ids({ viewer: owner.id, aiRead: true })).toEqual(['priv-1', sampleNode.id].sort());
    // Teammate / outsider: only team, regardless of aiRead.
    expect(await ids({ viewer: mate.id })).toEqual([sampleNode.id]);
    expect(await ids({ viewer: mate.id, aiRead: true })).toEqual([sampleNode.id]);
    expect(await ids({ viewer: outsider.id })).toEqual([sampleNode.id]);
  });
});

describe('graph CRUD (workspace-scoped)', () => {
  it('round-trips a node', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    await repo.upsertNode(ws.id, sampleNode);
    const back = await repo.getNode(ws.id, sampleNode.id);
    expect(back).toEqual(sampleNode);
  });

  it('archive removes from active listing but preserves the row', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    await repo.upsertNode(ws.id, sampleNode);
    await repo.archiveNode(ws.id, sampleNode.id);
    expect(await repo.listNodes(ws.id, { activeOnly: true })).toHaveLength(0);
    expect(await repo.listNodes(ws.id)).toHaveLength(1);
  });
});

describe('cross-workspace isolation — tripwire tests', () => {
  it('reads from workspace A cannot see workspace B nodes', async () => {
    const a = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    const b = await repo.createWorkspace({ name: 'B', owner_email: 'b@b.com' });
    await repo.upsertNode(a.id, sampleNode);
    expect(await repo.getNode(b.id, sampleNode.id)).toBeUndefined();
    expect(await repo.listNodes(b.id)).toHaveLength(0);
    expect(await repo.listNodes(a.id)).toHaveLength(1);
  });

  it('updating a node with the wrong workspace_id fails', async () => {
    const a = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    const b = await repo.createWorkspace({ name: 'B', owner_email: 'b@b.com' });
    await repo.upsertNode(a.id, sampleNode);
    await expect(async () => await repo.updateNode(b.id, sampleNode.id, sampleNode)).rejects.toThrow();
  });

  it('mcp tokens issued in workspace A do not resolve to workspace B', async () => {
    const a = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    const b = await repo.createWorkspace({ name: 'B', owner_email: 'b@b.com' });
    const userA = await repo.findOrCreateUser('a@a.com');
    const { token } = await repo.issueMcpToken({ workspace_id: a.id, user_id: userA.id });
    const resolved = await repo.resolveMcpToken(token);
    expect(resolved?.workspace_id).toBe(a.id);
    expect(resolved?.workspace_id).not.toBe(b.id);
  });

  it('synth_cache key collision across workspaces returns the right value (we include workspace_id in cache_key)', async () => {
    const a = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    const b = await repo.createWorkspace({ name: 'B', owner_email: 'b@b.com' });
    const sharedKey = 'question:roadmap-stance';
    // Phase 1 callers must always prefix cache keys with workspace_id.
    await repo.cacheSet({ cache_key: `${a.id}:${sharedKey}`, workspace_id: a.id, value: { answer: 'A answer' }, ttlSec: 300 });
    await repo.cacheSet({ cache_key: `${b.id}:${sharedKey}`, workspace_id: b.id, value: { answer: 'B answer' }, ttlSec: 300 });
    const got = await repo.cacheGet(`${a.id}:${sharedKey}`) as { answer: string };
    expect(got.answer).toBe('A answer');
  });
});

describe('candidates: insert, list, approve, reject', () => {
  it('candidate flows end to end', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    await repo.insertCandidate(ws.id, {
      id: 'cand-1',
      proposed_node: sampleNode,
      flag: 'red',
      source_quote: '...',
      source_ref: 'slack:x',
      confidence: 0.9,
    });
    const list = await repo.listCandidates(ws.id, { status: 'pending' });
    expect(list).toHaveLength(1);
    await repo.approveCandidate(ws.id, 'cand-1');
    expect(await repo.getNode(ws.id, sampleNode.id)).toBeDefined();
    expect(await repo.listCandidates(ws.id, { status: 'pending' })).toHaveLength(0);
  });

});

describe('audit log', () => {
  it('records workspace creation + node + candidate events', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    await repo.upsertNode(ws.id, sampleNode);
    await repo.insertCandidate(ws.id, {
      id: 'cand-1',
      proposed_node: sampleNode,
      flag: 'green',
      source_quote: 'x',
      source_ref: 'doc',
      confidence: 0.9,
    });
    await repo.approveCandidate(ws.id, 'cand-1');
    const events = (await repo.listAudit(ws.id)).map((e) => e.event);
    expect(events).toEqual(
      expect.arrayContaining(['workspace.created', 'graph.node.created', 'candidate.approved']),
    );
  });

  it('audit entries are workspace-scoped', async () => {
    const a = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    const b = await repo.createWorkspace({ name: 'B', owner_email: 'b@b.com' });
    await repo.upsertNode(a.id, sampleNode);
    const aEvents = await repo.listAudit(a.id);
    const bEvents = await repo.listAudit(b.id);
    expect(aEvents.length).toBeGreaterThan(bEvents.length);
  });
});

describe('team directory (listDomainDirectory)', () => {
  it('groups people by email domain with their workspaces, roles, and profiles', async () => {
    // Two people on acme.com, one on other.com. Ada owns a workspace Ben also
    // belongs to (as member); Ada also owns a second workspace of her own.
    const shared = await repo.createWorkspace({ name: 'Shared', owner_email: 'ada@acme.com' });
    const solo = await repo.createWorkspace({ name: 'Solo', owner_email: 'ada@acme.com' });
    await repo.createWorkspace({ name: 'Elsewhere', owner_email: 'zoe@other.com' });
    const ben = await repo.findOrCreateUser('ben@acme.com');
    await repo.addMember({ workspace_id: shared.id, user_id: ben.id, role: 'member' });

    const dir = await repo.listDomainDirectory('acme.com');
    const emails = dir.map((u) => u.email).sort();
    expect(emails).toEqual(['ada@acme.com', 'ben@acme.com']);
    expect(dir.some((u) => u.email === 'zoe@other.com')).toBe(false);

    const ada = dir.find((u) => u.email === 'ada@acme.com')!;
    expect(ada.workspaces.map((w) => w.name).sort()).toEqual(['Shared', 'Solo']);
    const soloWs = ada.workspaces.find((w) => w.name === 'Solo')!;
    expect(soloWs).not.toHaveProperty('plan');
    expect(soloWs.role).toBe('workspace_admin');
    // Every workspace surfaces at least its 'default' subgraph as a type.
    expect(soloWs.profiles.length).toBeGreaterThanOrEqual(1);

    const benDir = dir.find((u) => u.email === 'ben@acme.com')!;
    expect(benDir.workspaces.map((w) => w.name)).toEqual(['Shared']);
    expect(benDir.workspaces[0]!.role).toBe('member');
  });

  it('is case-insensitive on the domain and empty for unknown domains', async () => {
    await repo.createWorkspace({ name: 'A', owner_email: 'ada@Acme.com' });
    // Identity emails are normalized to lowercase on create (findOrCreateUser),
    // so a mixed-case owner_email is stored — and returned — lowercased. This is
    // the normalization that stops a differently-cased login minting a 2nd user.
    expect((await repo.listDomainDirectory('acme.com')).map((u) => u.email)).toEqual(['ada@acme.com']);
    expect(await repo.listDomainDirectory('nope.com')).toEqual([]);
    expect(await repo.listDomainDirectory('')).toEqual([]);
  });

  // A public mailbox provider is not a company: two people who both signed up
  // with a gmail.com address are strangers, and the folder explorer must not
  // show them each other's folders.
  it('never groups strangers who merely share a personal email provider', async () => {
    const adaWs = await repo.createWorkspace({ name: 'Ada Personal', owner_email: 'ada@gmail.com' });
    await repo.createWorkspace({ name: 'Ben Personal', owner_email: 'ben@gmail.com' });
    await repo.createWorkspace({ name: 'Cleo Outlook', owner_email: 'cleo@outlook.com' });
    const ada = await repo.findOrCreateUser('ada@gmail.com');
    const ben = await repo.findOrCreateUser('ben@gmail.com');

    // Ada sees herself and her own folder — and nothing of Ben's.
    const adaDir = await repo.listDomainDirectory('gmail.com', ada.id);
    expect(adaDir.map((u) => u.email)).toEqual(['ada@gmail.com']);
    expect(adaDir[0]!.workspaces.map((w) => w.name)).toEqual(['Ada Personal']);

    // Symmetrically for Ben.
    expect((await repo.listDomainDirectory('gmail.com', ben.id)).map((u) => u.email)).toEqual([
      'ben@gmail.com',
    ]);

    // With no viewer there is no "everyone on gmail.com" to hand out at all.
    expect(await repo.listDomainDirectory('gmail.com')).toEqual([]);
    expect(await repo.listDomainDirectory('outlook.com', ada.id)).toEqual([]);

    // Membership is still the way in: invited to Ada's folder, Ben reaches it
    // through his own memberships (not through the domain directory).
    await repo.addMember({ workspace_id: adaWs.id, user_id: ben.id, role: 'member' });
    expect((await repo.listMembershipsWithWorkspace(ben.id)).map((m) => m.name)).toContain('Ada Personal');
    expect((await repo.listDomainDirectory('gmail.com', ben.id)).map((u) => u.email)).toEqual([
      'ben@gmail.com',
    ]);
  });

  it('still groups a company domain, and honours the org-domain override', async () => {
    await repo.createWorkspace({ name: 'Co A', owner_email: 'ada@company.com' });
    await repo.createWorkspace({ name: 'Co B', owner_email: 'ben@company.com' });
    const ada = await repo.findOrCreateUser('ada@company.com');
    expect((await repo.listDomainDirectory('company.com', ada.id)).map((u) => u.email).sort()).toEqual([
      'ada@company.com',
      'ben@company.com',
    ]);

    // A team whose real company mail lives on a provider opts back in.
    await repo.createWorkspace({ name: 'Y1', owner_email: 'x@yahoo.com' });
    await repo.createWorkspace({ name: 'Y2', owner_email: 'y@yahoo.com' });
    const x = await repo.findOrCreateUser('x@yahoo.com');
    expect((await repo.listDomainDirectory('yahoo.com', x.id)).map((u) => u.email)).toEqual(['x@yahoo.com']);
    process.env.POMEGRANATE_ORG_EMAIL_DOMAINS = 'yahoo.com';
    try {
      expect((await repo.listDomainDirectory('yahoo.com', x.id)).map((u) => u.email).sort()).toEqual([
        'x@yahoo.com',
        'y@yahoo.com',
      ]);
    } finally {
      delete process.env.POMEGRANATE_ORG_EMAIL_DOMAINS;
    }
  });
});

describe('claude.ai connectors', () => {
  async function setup() {
    const ws = await repo.createWorkspace({ name: 'Team', owner_email: 'owner@a.com' });
    const owner = await repo.findOrCreateUser('owner@a.com');
    return { ws, owner };
  }

  it('resolves a connector secret to its (workspace, user) — the URL is the credential', async () => {
    const { ws, owner } = await setup();
    const { id, secret } = await repo.createConnector({ workspace_id: ws.id, user_id: owner.id });
    expect(id).toMatch(/^con_/);
    const resolved = await repo.resolveConnectorSecret(secret);
    expect(resolved).toEqual({ id, workspace_id: ws.id, user_id: owner.id });
  });

  it('fails closed for an unknown or revoked secret', async () => {
    const { ws, owner } = await setup();
    const { id, secret } = await repo.createConnector({ workspace_id: ws.id, user_id: owner.id });
    expect(await repo.resolveConnectorSecret('con_nonsense')).toBeUndefined();
    await repo.revokeConnector(ws.id, id, owner.id);
    expect(await repo.resolveConnectorSecret(secret)).toBeUndefined();
  });

  it('a connector secret cannot authenticate against another workspace', async () => {
    const { ws: wsA, owner: ownerA } = await setup();
    const wsB = await repo.createWorkspace({ name: 'Other', owner_email: 'other@b.com' });
    const { secret } = await repo.createConnector({ workspace_id: wsA.id, user_id: ownerA.id });
    const resolved = await repo.resolveConnectorSecret(secret);
    expect(resolved?.workspace_id).toBe(wsA.id);
    expect(resolved?.workspace_id).not.toBe(wsB.id);
  });

  it('lists only live connectors and never exposes the secret', async () => {
    const { ws, owner } = await setup();
    const a = await repo.createConnector({ workspace_id: ws.id, user_id: owner.id, label: 'Marketing' });
    const b = await repo.createConnector({ workspace_id: ws.id, user_id: owner.id });
    await repo.revokeConnector(ws.id, b.id, owner.id);
    const live = await repo.listConnectors(ws.id);
    expect(live.map((c) => c.id)).toEqual([a.id]);
    expect(live[0]!.label).toBe('Marketing');
    expect(JSON.stringify(live)).not.toContain(a.secret);
  });
});

describe('ingestion/sharing rules', () => {
  it('inserts, reads back (parsing scopes/phases), updates by id, and deletes', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    const created = await repo.upsertRule(ws.id, {
      instructions: 'Hide PII',
      scopes: ['only_me', 'private', 'team'],
      phases: ['store', 'use'],
      action: 'shape',
    });
    expect(created.id).toMatch(/^r_/);
    expect(created.scopes).toEqual(['only_me', 'private', 'team']);
    expect(created.phases).toEqual(['store', 'use']);
    expect(created.enabled).toBe(true);

    // Upsert by id updates in place (no new row), preserving created_at.
    const updated = await repo.upsertRule(ws.id, {
      id: created.id,
      instructions: 'Hide PII (revised)',
      scopes: ['team'],
      phases: ['use'],
      enabled: false,
    });
    expect(await repo.listRules(ws.id)).toHaveLength(1);
    expect(updated.instructions).toBe('Hide PII (revised)');
    expect(updated.scopes).toEqual(['team']);
    expect(updated.enabled).toBe(false);
    expect(updated.created_at).toBe(created.created_at);

    await repo.deleteRule(ws.id, created.id);
    expect(await repo.listRules(ws.id)).toEqual([]);
  });

  it('seeds the three defaults once and never resurrects a deleted default', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    await repo.seedDefaultRules(ws.id, null);
    const seeded = await repo.listRules(ws.id);
    expect(seeded).toHaveLength(3);
    // Uses the unified 3-tier model — no legacy 'local'.
    expect(seeded.flatMap((r) => r.scopes)).not.toContain('local');
    expect(seeded.find((r) => r.instructions.startsWith('Hide PII'))?.scopes).toEqual([
      'only_me',
      'private',
      'team',
    ]);

    // Idempotent: a second seed is a no-op.
    await repo.seedDefaultRules(ws.id, null);
    expect(await repo.listRules(ws.id)).toHaveLength(3);

    // Deleting a default and re-seeding does NOT bring it back (count > 0 guard).
    await repo.deleteRule(ws.id, seeded[0]!.id);
    await repo.seedDefaultRules(ws.id, null);
    expect(await repo.listRules(ws.id)).toHaveLength(2);
  });

  it('scopes rules per workspace', async () => {
    const a = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    const b = await repo.createWorkspace({ name: 'B', owner_email: 'b@b.com' });
    await repo.upsertRule(a.id, { instructions: 'only in A', scopes: ['team'], phases: ['store'] });
    expect(await repo.listRules(a.id)).toHaveLength(1);
    expect(await repo.listRules(b.id)).toEqual([]);
  });
});

describe('unified automations', () => {
  it('inserts a shape automation, reads it back, updates by id, and deletes', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    const created = await repo.upsertAutomation(ws.id, {
      kind: 'shape',
      instructions: 'Hide PII',
      scopes: ['only_me', 'private', 'team'],
      phases: ['store', 'use'],
      action: 'shape',
    });
    expect(created.id).toMatch(/^au_/);
    expect(created.kind).toBe('shape');
    expect(created.scopes).toEqual(['only_me', 'private', 'team']);
    expect(created.phases).toEqual(['store', 'use']);
    expect(created.enabled).toBe(true);

    const updated = await repo.upsertAutomation(ws.id, {
      id: created.id,
      kind: 'shape',
      instructions: 'Hide PII (revised)',
      scopes: ['team'],
      phases: ['use'],
      enabled: false,
    });
    expect(await repo.listAutomations(ws.id)).toHaveLength(1);
    expect(updated.instructions).toBe('Hide PII (revised)');
    expect(updated.enabled).toBe(false);
    expect(updated.created_at).toBe(created.created_at);

    await repo.deleteAutomation(ws.id, created.id);
    expect(await repo.listAutomations(ws.id)).toEqual([]);
  });

  it('round-trips an apps_pull automation including criteria JSON and cadence', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    const now = new Date();
    const created = await repo.upsertAutomation(ws.id, {
      kind: 'apps_pull',
      connector: 'github',
      criteria: {
        query: 'PRs about onboarding',
        filter: 'only merged PRs',
        count: 10,
        audience: 'team',
        recency: { since_relative: 'last 7 days', anchor_to_watermark: true },
        github: { repo: 'acme/web', mode: 'prs' },
      },
      cadence_ms: 24 * 60 * 60 * 1000,
      next_run_at: now.toISOString(),
      owner_user_id: 'u_1',
    });
    expect(created.kind).toBe('apps_pull');
    expect(created.criteria?.github?.repo).toBe('acme/web');
    expect(created.cadence_ms).toBe(24 * 60 * 60 * 1000);

    const due = await repo.dueAutomations(new Date(now.getTime() + 1000));
    expect(due.map((a) => a.id)).toContain(created.id);

    await repo.advanceAutomation(ws.id, created.id, {
      last_run_at: now.toISOString(),
      next_run_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      watermark: now.toISOString(),
    });
    const notDueAnymore = await repo.dueAutomations(new Date(now.getTime() + 1000));
    expect(notDueAnymore.map((a) => a.id)).not.toContain(created.id);
  });

  it('never surfaces a track_directory automation as due (cadence_ms always NULL)', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    await repo.upsertAutomation(ws.id, {
      kind: 'track_directory',
      device_id: 'device-1',
      local_path: '/Users/jane/Downloads',
      // no cadence_ms / next_run_at set — mirrors the plan's "never centrally scheduled"
    });
    expect(await repo.dueAutomations(new Date())).toEqual([]);
  });

  it('records automation runs and lists them newest-first, scoped per automation', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    const a = await repo.upsertAutomation(ws.id, { kind: 'apps_pull', connector: 'gmail' });
    await repo.recordAutomationRun(ws.id, {
      automation_id: a.id,
      trigger: 'scheduled',
      outcome: 'ok',
      items_seen: 5,
      items_ingested: 2,
      document_ids: ['doc_1', 'doc_2'],
      summary: 'Ingested 2 emails',
    });
    await repo.recordAutomationRun(ws.id, {
      automation_id: a.id,
      trigger: 'manual_run',
      outcome: 'error',
      error: 'connector timeout',
    });
    const runs = await repo.listAutomationRuns(ws.id, a.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.trigger).toBe('manual_run');
    expect(runs[0]!.outcome).toBe('error');
    expect(runs[1]!.document_ids).toEqual(['doc_1', 'doc_2']);
  });

  it('seeds the three default shape automations once and never resurrects a deleted default', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    await repo.seedDefaultAutomations(ws.id, null);
    const seeded = await repo.listAutomations(ws.id, 'shape');
    expect(seeded).toHaveLength(3);
    expect(seeded.find((a) => a.instructions?.startsWith('Hide PII'))?.scopes).toEqual([
      'only_me',
      'private',
      'team',
    ]);

    await repo.seedDefaultAutomations(ws.id, null);
    expect(await repo.listAutomations(ws.id, 'shape')).toHaveLength(3);

    await repo.deleteAutomation(ws.id, seeded[0]!.id);
    await repo.seedDefaultAutomations(ws.id, null);
    expect(await repo.listAutomations(ws.id, 'shape')).toHaveLength(2);
  });

  it('lazily migrates legacy rules into automations, preserving ids, without touching the rules table', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    await repo.seedDefaultRules(ws.id, null);
    const legacy = await repo.listRules(ws.id);
    expect(legacy).toHaveLength(3);

    await repo.migrateRulesToAutomations(ws.id);
    const migrated = await repo.listAutomations(ws.id, 'shape');
    expect(migrated).toHaveLength(3);
    expect(migrated.map((a) => a.id).sort()).toEqual(legacy.map((r) => r.id).sort());
    expect(migrated.find((a) => a.id === legacy[0]!.id)?.instructions).toBe(legacy[0]!.instructions);
    // The legacy table is untouched (read-only from here on).
    expect(await repo.listRules(ws.id)).toHaveLength(3);

    // Idempotent: deleting a migrated automation and re-running migration does
    // NOT resurrect it (shapeCount > 0 guard), even though the legacy row
    // still exists in `rules`.
    await repo.deleteAutomation(ws.id, migrated[0]!.id);
    await repo.migrateRulesToAutomations(ws.id);
    expect(await repo.listAutomations(ws.id, 'shape')).toHaveLength(2);
  });

  it('scopes automations per workspace', async () => {
    const a = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    const b = await repo.createWorkspace({ name: 'B', owner_email: 'b@b.com' });
    await repo.upsertAutomation(a.id, { kind: 'shape', instructions: 'only in A', scopes: ['team'], phases: ['store'] });
    expect(await repo.listAutomations(a.id)).toHaveLength(1);
    expect(await repo.listAutomations(b.id)).toEqual([]);
  });
});

describe('subgraph deletion (hard purge)', () => {
  // Seed one row in every subgraph-scoped table (SUBGRAPH_SCOPED_TABLES,
  // plus wiki_blocks + user_defaults which are handled specially by
  // deleteSubgraphRows), for BOTH the default and a second subgraph — so the
  // test can assert the purge only ever touches the target subgraph. Uses
  // repo convenience methods where they don't enforce profile/kind
  // validation (that validation isn't what this test is about); raw SQL for
  // candidates/graph_edges, which do validate their kind against the
  // subgraph's profile.
  async function seed(ws: string, subgraph_id: string, tag: string) {
    await repo.setWorkspaceProfile(ws, 'founding', {} as any, subgraph_id);
    const nodeId = `n_${tag}`;
    await repo.upsertNode(
      ws,
      { id: nodeId, type: 'positioning', created_at: ts, updated_at: ts, status: 'active', body: `body ${tag}`, kind: 'stance' } as Node,
      undefined,
      undefined,
      subgraph_id,
    );
    const node2Id = `n2_${tag}`;
    await repo.upsertNode(
      ws,
      { id: node2Id, type: 'positioning', created_at: ts, updated_at: ts, status: 'active', body: `body2 ${tag}`, kind: 'stance' } as Node,
      undefined,
      undefined,
      subgraph_id,
    );
    const doc = await repo.registerDocument(ws, { source_ref: `doc-${tag}.md`, source_kind: 'doc', sha256: `sha-${tag}` });
    await repo.routeDocument(ws, doc.id, subgraph_id);
    repo.db
      .prepare(
        `INSERT INTO candidates (id, workspace_id, flag, proposed_node, source_quote, source_ref, confidence, status, proposed_by, created_at, document_id, subgraph_id)
         VALUES (?, ?, 'green', ?, 'quote', 'doc', 0.9, 'pending', 'system', ?, ?, ?)`,
      )
      .run(`c_${tag}`, ws, JSON.stringify({ id: nodeId, type: 'positioning' }), ts, doc.id, subgraph_id);
    await repo.setGroupsCache({ workspace_id: ws, signature: `sig-${tag}`, groups: [], candidate_count: 0, subgraph_id });
    await repo.setDocTriage({ workspace_id: ws, document_id: doc.id, signature: `sig-${tag}`, assessment: {}, subgraph_id });
    await repo.createCurationConversation(ws, doc.id, '1', subgraph_id);
    await repo.appendCurationMessage(ws, doc.id, 'event', `msg ${tag}`, undefined, undefined, subgraph_id);
    await repo.addNodeEvidence(ws, { node_id: nodeId, document_id: doc.id, quote: 'q' }, subgraph_id);
    repo.db
      .prepare(
        `INSERT INTO graph_edges (id, workspace_id, src, dst, kind, status, created_by, created_at, updated_at, subgraph_id)
         VALUES (?, ?, ?, ?, 'relates_to', 'active', 'manual', ?, ?, ?)`,
      )
      .run(`e_${tag}`, ws, nodeId, node2Id, ts, ts, subgraph_id);
    await repo.upsertWiki(ws, subgraph_id, { profile_id: 'notes' });
    const page = await repo.insertWikiPage(ws, subgraph_id, { slug: `page-${tag}`, title: `Page ${tag}` });
    await repo.insertWikiBlock(ws, page.id, { sort_order: 0, type: 'paragraph', content: { text: 'x' } });
    await repo.recordContextAccess(ws, { channel: 'web', tool: 'query', subgraph_id, request_text: `q ${tag}` });
    return { nodeId, node2Id, docId: doc.id, pageId: page.id };
  }

  it('deleteSubgraphRows purges every scoped table for the target subgraph only, and countSubgraphRows tripwires it', async () => {
    const ws = await repo.createWorkspace({ name: 'Purge', owner_email: 'purge@a.com' });
    const owner = await repo.findOrCreateUser('purge@a.com');
    const target = await repo.createSubgraph(ws.id, { slug: 'target', name: 'Target' });

    const keep = await seed(ws.id, 'default', 'keep');
    const gone = await seed(ws.id, target.id, 'gone');
    await repo.setUserDefault(owner.id, 'all', ws.id, target.id);

    // Sanity: both subgraphs have rows pre-purge.
    const preKeep = await repo.countSubgraphRows(ws.id, 'default');
    const preGone = await repo.countSubgraphRows(ws.id, target.id);
    for (const [table, n] of Object.entries(preKeep)) expect(n, `default/${table}`).toBeGreaterThan(0);
    for (const [table, n] of Object.entries(preGone)) expect(n, `target/${table}`).toBeGreaterThan(0);

    const counts = await repo.deleteSubgraphRows(ws.id, target.id);
    expect(counts.wiki_blocks).toBe(1);
    expect(counts.subgraphs).toBe(1);
    expect(counts.user_defaults_cleared).toBe(1);

    // Every subgraph-scoped table is now empty for the purged subgraph — the
    // tripwire: if a future table is added to SUBGRAPH_SCOPED_TABLES without
    // being swept in deleteSubgraphRows, this loop catches it.
    const post = await repo.countSubgraphRows(ws.id, target.id);
    for (const [table, n] of Object.entries(post)) {
      expect(n, `table ${table} still has rows for the purged subgraph`).toBe(0);
    }
    expect(await repo.getSubgraph(ws.id, target.id)).toBeUndefined();
    // wiki_blocks has no subgraph_id of its own, so it's verified via the
    // page id captured before the purge (the page itself is gone too).
    const remainingBlocks = repo.db.prepare(`SELECT COUNT(*) AS n FROM wiki_blocks WHERE page_id = ?`).get(gone.pageId) as { n: number };
    expect(remainingBlocks.n).toBe(0);

    // The other subgraph's rows are completely untouched.
    const stillKeep = await repo.countSubgraphRows(ws.id, 'default');
    for (const [table, n] of Object.entries(stillKeep)) expect(n, `default/${table} after purge`).toBeGreaterThan(0);
    expect(await repo.getNode(ws.id, keep.nodeId)).toBeTruthy();

    // The purged subgraph's node is gone; the surviving subgraph's is intact.
    expect(await repo.getNode(ws.id, gone.nodeId)).toBeUndefined();
    expect(await repo.getNode(ws.id, keep.nodeId)).toBeTruthy();

    // Shared rows (documents) are untouched — only document_routing (a
    // per-subgraph pointer) was swept.
    const docRow = repo.db.prepare(`SELECT id FROM documents WHERE workspace_id = ? AND id = ?`).get(ws.id, gone.docId);
    expect(docRow).toBeTruthy();

    // The per-user default pointer that targeted the purged subgraph was
    // cleared (not deleted) rather than left dangling.
    expect((await repo.getUserDefault(owner.id, 'all'))?.subgraph_id).toBeNull();
  });

  it('can migrate the default folder into another folder before purging it', async () => {
    const ws = await repo.createWorkspace({ name: 'Migration', owner_email: 'migration@a.com' });
    const target = await repo.createSubgraph(ws.id, { slug: 'target', name: 'Target' });
    const seeded = await seed(ws.id, 'default', 'default-migration');
    await repo.migrateSubgraphRows(ws.id, 'default', target.id);
    await repo.deleteSubgraphRows(ws.id, 'default');
    expect(await repo.getSubgraph(ws.id, 'default')).toBeUndefined();
    expect((await repo.listNodes(ws.id, {}, target.id)).some((node) => node.id === seeded.nodeId)).toBe(true);
    expect(repo.db.prepare(`SELECT COUNT(*) AS n FROM wiki_blocks WHERE page_id = ?`).get(seeded.pageId)).toEqual({ n: 1 });
    expect((await repo.listSubgraphDocuments(ws.id, target.id)).length).toBe(1);
  });
});

describe('data agents (spec-data-agents-and-subfolder-wiki.md)', () => {
  const betTemplate: ContextProfile = {
    id: 'bet_tracker',
    name: 'Bet Tracker',
    description: 'Tracks product bets and their status, for testing.',
    shape: 'items',
    kinds: [
      {
        key: 'bet',
        label: 'Bet',
        label_plural: 'Bets',
        color: 2,
        description: 'A product direction being pursued.',
        attrs: [{ key: 'status', label: 'Status', type: 'enum', values: ['proposed', 'active', 'shelved'] }],
        progress: { attr: 'status', settled_values: ['shelved'] },
      },
    ],
    feedback_dimensions: [{ key: 'accuracy', label: 'Accuracy', description: 'x' }],
    review_kinds: ['bet'],
    query_scopes: [{ key: 'all', label: 'Everything', kind_keys: 'all' }],
    flag_semantics: { red: 'x', yellow: 'y', green: 'z' },
    edge_kinds: [],
    edges_deliberately_empty: true,
  };

  async function setup() {
    const ws = await repo.createWorkspace({ name: 'Agent Test', owner_email: 'owner@a.com' });
    const owner = await repo.findOrCreateUser('owner@a.com');
    const sg = await repo.createSubgraph(ws.id, { slug: 'ideas', name: 'Product Ideas' });
    return { ws, owner, sg };
  }

  it('no row → getActiveDataAgent is undefined (the note-path default)', async () => {
    const { ws, sg } = await setup();
    expect(await repo.getActiveDataAgent(ws.id, sg.id)).toBeUndefined();
  });

  it('attach creates an active row with a FROZEN template snapshot', async () => {
    const { ws, owner, sg } = await setup();
    await repo.attachDataAgent(ws.id, sg.id, {
      template_id: 'bet_tracker',
      template: betTemplate,
      cadence: 'per_document',
      attached_by: owner.id,
    });
    const active = await repo.getActiveDataAgent(ws.id, sg.id);
    expect(active?.template_id).toBe('bet_tracker');
    expect(active?.cadence).toBe('per_document');
    expect(active?.template.kinds[0]?.key).toBe('bet');

    // Frozen: mutating the ORIGINAL object after attach must not reach the
    // stored snapshot (spec §5.3 — an attached copy is frozen until an
    // explicit push, and attach itself must not alias the caller's object).
    (betTemplate.kinds[0] as { description: string }).description = 'mutated after attach';
    expect((await repo.getActiveDataAgent(ws.id, sg.id))?.template.kinds[0]?.description).toBe(
      'A product direction being pursued.',
    );
  });

  it('one agent at a time: attaching a second template REPLACES the first (Change, §4.1)', async () => {
    const { ws, owner, sg } = await setup();
    await repo.attachDataAgent(ws.id, sg.id, { template_id: 'bet_tracker', template: betTemplate, cadence: 'once', attached_by: owner.id });
    const todo: ContextProfile = { ...betTemplate, id: 'todo_list', name: 'To-do', kinds: [{ ...betTemplate.kinds[0]!, key: 'task' }] };
    await repo.attachDataAgent(ws.id, sg.id, { template_id: 'todo_list', template: todo, cadence: 'once', attached_by: owner.id });
    const active = await repo.getActiveDataAgent(ws.id, sg.id);
    expect(active?.template_id).toBe('todo_list');
    // Exactly one row for this subfolder — the PK, not application logic,
    // is what enforces "one at a time".
    const count = (repo as unknown as { db: Database.Database }).db
      .prepare(`SELECT COUNT(*) AS n FROM subfolder_data_agents WHERE workspace_id = ? AND subgraph_id = ?`)
      .get(ws.id, sg.id) as { n: number };
    expect(count.n).toBe(1);
  });

  it('detach turns the agent off but KEEPS the row (status=detached), not deleted', async () => {
    const { ws, owner, sg } = await setup();
    await repo.attachDataAgent(ws.id, sg.id, { template_id: 'bet_tracker', template: betTemplate, cadence: 'once', attached_by: owner.id });
    await repo.detachDataAgent(ws.id, sg.id);
    expect(await repo.getActiveDataAgent(ws.id, sg.id)).toBeUndefined();
    const row = (repo as unknown as { db: Database.Database }).db
      .prepare(`SELECT status FROM subfolder_data_agents WHERE workspace_id = ? AND subgraph_id = ?`)
      .get(ws.id, sg.id) as { status: string } | undefined;
    expect(row?.status).toBe('detached');
  });

  it('detach on a folder with no agent is a harmless no-op', async () => {
    const { ws, sg } = await setup();
    await repo.detachDataAgent(ws.id, sg.id);
    expect(await repo.getActiveDataAgent(ws.id, sg.id)).toBeUndefined();
  });

  it('re-attaching after detach makes it active again', async () => {
    const { ws, owner, sg } = await setup();
    await repo.attachDataAgent(ws.id, sg.id, { template_id: 'bet_tracker', template: betTemplate, cadence: 'once', attached_by: owner.id });
    await repo.detachDataAgent(ws.id, sg.id);
    await repo.attachDataAgent(ws.id, sg.id, { template_id: 'bet_tracker', template: betTemplate, cadence: 'scheduled', cadence_ms: 3600_000, attached_by: owner.id });
    const active = await repo.getActiveDataAgent(ws.id, sg.id);
    expect(active?.cadence).toBe('scheduled');
    expect(active?.cadence_ms).toBe(3600_000);
  });

  it('listActiveDataAgentSubgraphs returns only subfolders with a currently-active agent', async () => {
    const { ws, owner, sg } = await setup();
    const other = await repo.createSubgraph(ws.id, { slug: 'other', name: 'Other' });
    await repo.attachDataAgent(ws.id, sg.id, { template_id: 'bet_tracker', template: betTemplate, cadence: 'once', attached_by: owner.id });
    await repo.attachDataAgent(ws.id, other.id, { template_id: 'bet_tracker', template: betTemplate, cadence: 'once', attached_by: owner.id });
    await repo.detachDataAgent(ws.id, other.id);
    expect((await repo.listActiveDataAgentSubgraphs(ws.id)).sort()).toEqual([sg.id].sort());
  });

  describe('custom template CRUD', () => {
    it('save (create) then list then get round-trip', async () => {
      const { ws, owner } = await setup();
      const { id } = await repo.saveDataAgentTemplate(ws.id, { name: 'Bet Tracker', profile: betTemplate, created_by: owner.id });
      expect(id).toMatch(/^tpl_/);
      expect((await repo.listDataAgentTemplates(ws.id)).map((t) => t.id)).toEqual([id]);
      expect((await repo.getDataAgentTemplate(ws.id, id))?.kinds[0]?.key).toBe('bet');
    });

    it('save with an existing id overwrites in place (Save, §4.2) — created_at survives, updated_at moves', async () => {
      const { ws, owner } = await setup();
      const { id } = await repo.saveDataAgentTemplate(ws.id, { name: 'Bet Tracker', profile: betTemplate, created_by: owner.id });
      const before = (await repo.listDataAgentTemplates(ws.id))[0]!;
      const edited: ContextProfile = { ...betTemplate, description: 'Edited description.' };
      await repo.saveDataAgentTemplate(ws.id, { id, name: 'Bet Tracker', profile: edited, created_by: owner.id });
      const after = (await repo.listDataAgentTemplates(ws.id))[0]!;
      expect(after.id).toBe(before.id);
      expect(after.created_at).toBe(before.created_at);
      expect(after.profile.description).toBe('Edited description.');
    });

    it('"Save as new template" (a plain save with no id) forks an independent copy', async () => {
      const { ws, owner } = await setup();
      const { id: original } = await repo.saveDataAgentTemplate(ws.id, { name: 'Bet Tracker', profile: betTemplate, created_by: owner.id });
      const { id: fork } = await repo.saveDataAgentTemplate(ws.id, {
        name: 'Bet Tracker (copy)',
        profile: betTemplate,
        forked_from: original,
        created_by: owner.id,
      });
      expect(fork).not.toBe(original);
      expect(await repo.listDataAgentTemplates(ws.id)).toHaveLength(2);
    });

    it('countActiveUsersOfTemplate reflects only active bindings, workspace-scoped', async () => {
      const { ws, owner, sg } = await setup();
      const other = await repo.createSubgraph(ws.id, { slug: 'other', name: 'Other' });
      const { id } = await repo.saveDataAgentTemplate(ws.id, { name: 'Bet Tracker', profile: betTemplate, created_by: owner.id });
      expect(await repo.countActiveUsersOfTemplate(ws.id, id)).toBe(0);
      await repo.attachDataAgent(ws.id, sg.id, { template_id: id, template: betTemplate, cadence: 'once', attached_by: owner.id });
      await repo.attachDataAgent(ws.id, other.id, { template_id: id, template: betTemplate, cadence: 'once', attached_by: owner.id });
      expect(await repo.countActiveUsersOfTemplate(ws.id, id)).toBe(2);
      await repo.detachDataAgent(ws.id, other.id);
      expect(await repo.countActiveUsersOfTemplate(ws.id, id)).toBe(1);
    });

    it('delete removes the template row (guard against in-use deletion is the caller\'s job, routes.ts)', async () => {
      const { ws, owner } = await setup();
      const { id } = await repo.saveDataAgentTemplate(ws.id, { name: 'Bet Tracker', profile: betTemplate, created_by: owner.id });
      await repo.deleteDataAgentTemplate(ws.id, id);
      expect(await repo.getDataAgentTemplate(ws.id, id)).toBeUndefined();
    });
  });
});

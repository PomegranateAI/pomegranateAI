/**
 * KEYSTONE ACCEPTANCE TEST — does the bot actually "review documents based on
 * the knowledge of someone in my team"?
 *
 * Runs the WHOLE assembled surface (createMentionHandler → real
 * HttpPomegranateClient → live app/server) with a fake Slack context. It seeds
 * TWO CONTRADICTORY canons and proves the feature is real by DIFFERENCE:
 *
 *   Alice  : BANS the phrase "AI assistant"; enterprise-first roadmap.
 *   Marcus     : APPROVES "AI assistant"; self-serve-first roadmap.
 *
 * The SAME document ("…the AI assistant… self-serve first…") is reviewed
 * `from @alice` and `from @marcus`. If the bot truly uses each person's
 * knowledge, Alice's review flags the document and Marcus's does not. If
 * the two reviews come back the same, the feature is NOT delivering — and this
 * test fails.
 *
 * Run via:  node_modules/.bin/tsx test/acceptance.ts   (POMEGRANATE_BASE set)
 */
import { createMentionHandler } from '../src/handlers.js';
import { createActionHandler } from '../src/actions.js';
import { HttpPomegranateClient } from '../src/client.js';
import { parseConfig } from '../src/config.js';
import { resolveCanon } from '../src/resolve.js';
import type { ActionContext, MentionContext, SlackFileRef, Finding } from '../src/types.js';

const BASE = process.env.POMEGRANATE_BASE ?? 'http://localhost:3017';
const j = async (r: Response) => { const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) as any }; } catch { return { s: r.status, b: t as any }; } };
const post = (p: string, body: unknown, hdr: Record<string, string> = {}) =>
  fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...hdr }, body: JSON.stringify(body) }).then(j);

const ok: string[] = [], bad: string[] = [];
const check = (name: string, cond: boolean, detail?: string) => { (cond ? ok : bad).push(name + (detail ? ` — ${detail}` : '')); };

// ----------------------------------------------------------------- provisioning
const now = new Date().toISOString();
const aliceNodes = [
  { id: 'p_ban_alice', type: 'positioning', created_at: now, updated_at: now, status: 'active',
    body: 'Never describe the product as an "AI assistant". We are a strategy substrate, not an assistant.', kind: 'banned_phrase' },
  { id: 'd_price_alice', type: 'decision', created_at: now, updated_at: now, status: 'active',
    summary: 'The roadmap is enterprise-first, SSO before self-serve',
    body: 'The roadmap is enterprise-first: SSO and audit logs ship before any self-serve features.',
    decided_on: '2026-04-01', decided_by: 'Alice', category: 'scope' },
];
const marcusNodes = [
  { id: 'p_ok_marcus', type: 'positioning', created_at: now, updated_at: now, status: 'active',
    body: 'Describing the product as an "AI assistant" is approved and encouraged for the self-serve audience.', kind: 'approved_phrase' },
  { id: 'd_price_marcus', type: 'decision', created_at: now, updated_at: now, status: 'active',
    summary: 'Self-serve onboarding is fully in-app',
    body: 'Self-serve onboarding is fully in-app: anyone can sign up and invite their team without SSO.',
    decided_on: '2026-04-15', decided_by: 'Marcus', category: 'scope' },
];

async function seedCanon(name: string, nodes: unknown[]) {
  const ml = await post('/auth/magic-link', { email: `admin+${name}@example.com` });
  const ex = await post('/auth/exchange', { code: ml.b.dev_code });
  const AUTH = { authorization: `Bearer ${ex.b.session}` };
  const ws = await post('/workspaces', { name: `${name} canon` }, AUTH);
  const WS = ws.b.id as string;
  for (const n of nodes) { const r = await post(`/workspaces/${WS}/graph`, n, AUTH); if (r.s !== 200) throw new Error(`seed ${name} failed: ${JSON.stringify(r.b)}`); }
  const tok = await post(`/workspaces/${WS}/mcp-tokens`, {}, AUTH);
  return { workspaceId: WS, token: tok.b.token as string };
}

const alice = await seedCanon('alice', aliceNodes);
const marcus = await seedCanon('marcus', marcusNodes);
check('provisioned two distinct canons', alice.workspaceId !== marcus.workspaceId, `${alice.workspaceId} vs ${marcus.workspaceId}`);

// --------------------------------------------------- build the surface (config + env + handler)
process.env.TOK_ALICE = alice.token;
process.env.TOK_MARCUS = marcus.token;
const config = parseConfig({
  teams: [{ slack_team_id: 'T1', pomegranate_api_url: BASE }],
  users: [
    { slack_team_id: 'T1', slack_user_id: 'U_ALICE', pomegranate_user_id: 'u_alice', pomegranate_workspace_id: alice.workspaceId, mcp_token_env: 'TOK_ALICE' },
    { slack_team_id: 'T1', slack_user_id: 'U_MARCUS', pomegranate_user_id: 'u_marcus', pomegranate_workspace_id: marcus.workspaceId, mcp_token_env: 'TOK_MARCUS' },
  ],
});
const client = new HttpPomegranateClient();
const handle = createMentionHandler({ config, client, botUserId: 'BOT', env: process.env });

function fakeCtx(text: string, eventId: string, files: SlackFileRef[] = []) {
  const replies: string[] = [], reacts: string[] = [], replyBlocks: Array<unknown[] | undefined> = [];
  const ctx: MentionContext = {
    text, files, requesterUserId: 'U_ALICE', teamId: 'T1', channelId: 'C_ACC', eventId,
    react: async (e) => { reacts.push(e); },
    reply: async (t, blocks) => { replies.push(t); replyBlocks.push(blocks); },
    fetchFileText: async () => '',
  };
  return { ctx, replies, reacts, replyBlocks };
}

const countRed = (s: string) => (s.match(/:red_circle:/g) ?? []).length;
const mentionsAssistant = (f: Finding) => /assistant/i.test(`${f.summary} ${f.quote_from_deliverable}`);

// The IDENTICAL document, reviewed against each person's knowledge.
const DOC = 'Meet Pomegranate, the AI assistant for your team. Simple in-app onboarding — set up in minutes.';

// =================================================================== END-TO-END (whole bot)
console.log('\n========== E2E: same document, two teammates\' canons ==========');
const hRun = fakeCtx(`<@BOT> review ${DOC} from <@U_ALICE>`, 'ev1');
await handle(hRun.ctx);
const mRun = fakeCtx(`<@BOT> review ${DOC} from <@U_MARCUS>`, 'ev2');
await handle(mRun.ctx);

const hReply = hRun.replies[0] ?? '';
const mReply = mRun.replies[0] ?? '';
console.log('--- Alice reply ---\n' + hReply);
console.log('--- Marcus reply ---\n' + mReply);

check('Alice review produced a reply', hRun.replies.length === 1);
check('Marcus review produced a reply', mRun.replies.length === 1);
check('both got an :eyes: ack', hRun.reacts[0] === ':eyes:' && mRun.reacts[0] === ':eyes:');
check('reply is addressed to the right subject', hReply.includes('U_ALICE') && mReply.includes('U_MARCUS'));

// THE KEYSTONE: identical doc → Alice flags more than Marcus.
check('★ DIFFERENTIAL: Alice flags the doc with more reds than Marcus (same doc, different knowledge)',
  countRed(hReply) > countRed(mReply), `alice reds=${countRed(hReply)} marcus reds=${countRed(mReply)}`);

// =================================================================== STRUCTURED (precise differential)
console.log('\n========== Structured findings differential ==========');
const req = { pomegranateUserId: null };
const hCanon = resolveCanon(config, 'T1', 'U_ALICE', process.env);
const mCanon = resolveCanon(config, 'T1', 'U_MARCUS', process.env);
const hf = (await client.review(hCanon, req, DOC)).findings;
const mf = (await client.review(mCanon, req, DOC)).findings;
console.log('Alice findings:', JSON.stringify(hf, null, 2));
console.log('Marcus findings:', JSON.stringify(mf, null, 2));

const hAssistantFlag = hf.find((f) => mentionsAssistant(f) && (f.flag === 'red' || f.flag === 'yellow'));
const mAssistantRed = mf.find((f) => mentionsAssistant(f) && f.flag === 'red');
check('★ Alice FLAGS the banned "AI assistant" phrase', !!hAssistantFlag,
  hAssistantFlag ? `flag=${hAssistantFlag.flag} node=${hAssistantFlag.node_id}` : 'no assistant flag found');
check('★ Marcus does NOT flag "AI assistant" as a problem (he approves it)', !mAssistantRed,
  mAssistantRed ? `unexpected red: ${mAssistantRed.summary}` : 'clean');
check('Alice has more red flags than Marcus', hf.filter(f=>f.flag==='red').length > mf.filter(f=>f.flag==='red').length,
  `alice reds=${hf.filter(f=>f.flag==='red').length} marcus reds=${mf.filter(f=>f.flag==='red').length}`);

// Integrity: every red cites a node that exists in THAT subject's graph.
const aliceIds = new Set(aliceNodes.map(n=>n.id)), marcusIds = new Set(marcusNodes.map(n=>n.id));
check('integrity: every Alice red cites a Alice node', hf.every(f=>f.flag!=='red' || (f.node_id && aliceIds.has(f.node_id))));
check('integrity: every Marcus red cites a Marcus node', mf.every(f=>f.flag!=='red' || (f.node_id && marcusIds.has(f.node_id))));
check('no cross-canon leakage: Alice never cites a Marcus node and vice-versa',
  hf.every(f=>!f.node_id || !marcusIds.has(f.node_id)) && mf.every(f=>!f.node_id || !aliceIds.has(f.node_id)));

// =================================================================== GetContext
console.log('\n========== GetContext ==========');
const gc = fakeCtx(`<@BOT> GetContext about ${DOC} from <@U_ALICE>`, 'ev3');
await handle(gc.ctx);
const gcReply = gc.replies[0] ?? '';
console.log('--- GetContext reply ---\n' + gcReply);
check('GetContext from Alice surfaces relevant context (not the empty message)',
  gc.replies.length === 1 && !/Nothing in .* looks relevant/.test(gcReply), gcReply.slice(0, 80));

const off = fakeCtx(`<@BOT> GetContext about My sourdough recipe: flour, water, salt, starter, bake at 230C. from <@U_ALICE>`, 'ev4');
await handle(off.ctx);
check('GetContext on off-topic material → "nothing relevant" (no fabrication)',
  /Nothing in .* looks relevant/.test(off.replies[0] ?? ''), (off.replies[0] ?? '').slice(0, 80));

// =================================================================== error paths (no synthesis call)
console.log('\n========== Error paths ==========');
const ghost = fakeCtx(`<@BOT> review ${DOC} from <@U_GHOST>`, 'ev5');
await handle(ghost.ctx);
check('unmapped subject → clean refusal, no ack',
  (ghost.replies[0] ?? '').includes('U_GHOST') && ghost.reacts.length === 0, ghost.replies[0]);

const empty = fakeCtx(`<@BOT> review from <@U_ALICE>`, 'ev6');
await handle(empty.ctx);
check('empty payload → acked then asked for content',
  empty.reacts[0] === ':eyes:' && empty.replies.length === 1, empty.replies[0]);

const dup = fakeCtx(`<@BOT> review ${DOC} from <@U_ALICE>`, 'ev1'); // reused eventId
await handle(dup.ctx);
check('duplicate Slack event id → no-op (no second reply)', dup.replies.length === 0);

// =================================================================== Curation: ingest → pending → approve (Phase 1 additions)
console.log('\n========== Curation: ingest → pending → button approve ==========');
const ING_DOC = 'DECISION: We are killing the legacy reseller program effective this month. ' +
  'New goal / north star for the year: 20 paying design-partner workspaces by Q3.';
const ing = fakeCtx(`<@BOT> ingest ${ING_DOC}`, 'ev7');
await handle(ing.ctx);
console.log('--- ingest reply ---\n' + (ing.replies[0] ?? ''));
check('ingest (no `from` clause) acked and reported proposed changes',
  ing.reacts[0] === ':eyes:' && /proposed change/.test(ing.replies[0] ?? ''), ing.replies[0]);

const foreignIngest = fakeCtx(`<@BOT> ingest some text from <@U_MARCUS>`, 'ev8');
await handle(foreignIngest.ctx);
check('ingest into someone else\'s workspace is refused',
  (foreignIngest.replies[0] ?? '').includes('your own workspace') && foreignIngest.reacts.length === 0,
  foreignIngest.replies[0]);

const pend = fakeCtx(`<@BOT> pending`, 'ev9');
await handle(pend.ctx);
const pendBlocks = (pend.replyBlocks[0] ?? []) as Array<any>;
const actionBlock = pendBlocks.find((b) => b?.type === 'actions');
check('pending replied with approve/reject buttons', !!actionBlock,
  `blocks=${pendBlocks.length} text=${(pend.replies[0] ?? '').slice(0, 60)}`);

if (actionBlock) {
  const candId = actionBlock.elements[0].value as string;
  const handleAction = createActionHandler({ config, client, env: process.env });
  const actionReplies: string[] = [];
  let updatedBlocks: unknown[] | null = null;
  const makeClick = (action: 'approve' | 'reject'): ActionContext => ({
    teamId: 'T1', actorUserId: 'U_ALICE', candidateId: candId, action,
    reply: async (t) => { actionReplies.push(t); },
    updateMessageBlocks: async (mutate) => { updatedBlocks = mutate(pendBlocks); },
  });

  await handleAction(makeClick('approve'));
  const stillPending = await client.listCandidates(hCanon, req);
  check('★ button approve resolves the candidate (no longer pending)',
    !stillPending.candidates.some((c) => c.id === candId),
    `candidate ${candId}, errors=${actionReplies.join('|') || 'none'}`);
  check('approve rewrote the message (buttons gone, resolution line added)',
    !!updatedBlocks && JSON.stringify(updatedBlocks).includes('Approved') &&
      !JSON.stringify(updatedBlocks).includes(`act:${candId}`));

  await handleAction(makeClick('reject'));
  check('second click on the same candidate is a safe no-op (already resolved)',
    !!updatedBlocks && JSON.stringify(updatedBlocks).includes('Already approved'));

  const foreignClick: ActionContext = {
    teamId: 'T1', actorUserId: 'U_GHOST', candidateId: candId, action: 'approve',
    reply: async (t) => { actionReplies.push(t); },
    updateMessageBlocks: async () => {},
  };
  await handleAction(foreignClick);
  check('unmapped clicker gets a clean refusal',
    (actionReplies.at(-1) ?? '').includes('U_GHOST'), actionReplies.at(-1));
}

// =================================================================== report
console.log('\n================= SUMMARY =================');
console.log(`PASS ${ok.length}:`); ok.forEach(x => console.log('  ✓ ' + x));
if (bad.length) { console.log(`\nFAIL ${bad.length}:`); bad.forEach(x => console.log('  ✗ ' + x)); }
console.log(bad.length ? '\nRESULT: FAIL — the bot is NOT delivering the user expectation' : '\nRESULT: PASS — reviews are grounded in the named teammate\'s knowledge');
process.exit(bad.length ? 1 : 0);

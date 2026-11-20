/**
 * Contract test for the Pomegranate Slack surface.
 *
 * Verifies the two wire contracts surfaces/slack depends on, against a LIVE
 * app/server — not a stub. This is the fidelity test: the surface's whole value
 * is that a Slack finding means the same thing as an app finding, so we assert
 * the real endpoints' shapes and integrity behavior.
 *
 * It provisions a throwaway workspace (a mock "subject canon"), seeds a small
 * graph, mints an MCP token, then calls the exact endpoints client.ts will:
 *   - POST /mcp/tools/review_deliverable   (the `review` verb)
 *   - POST /mcp/tools/query_context        (the `GetContext` verb, doc-as-question)
 *
 * Run against an isolated server + temp DB so it never touches real data:
 *   cd app/server
 *   PORT=3017 POMEGRANATE_DB_PATH=/tmp/pomg-ct/db.sqlite \
 *     POMEGRANATE_FILES_DIR=/tmp/pomg-ct/files \
 *     node_modules/.bin/tsx src/phase1/api/server.ts &
 *   POMEGRANATE_BASE=http://localhost:3017 node surfaces/slack/test/contract.mjs
 *
 * Requires ANTHROPIC_API_KEY in the server env (real synthesis calls; ~cents).
 * Last run: 2026-06-03 — 17/17 PASS (review shape + integrity; GetContext reuse
 * returns grounded extracts and correctly says has_answer=false on off-topic).
 */
const BASE = process.env.POMEGRANATE_BASE ?? 'http://localhost:3017';
const j = async (r) => { const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) }; } catch { return { s: r.status, b: t }; } };
const post = (p, body, hdr = {}) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...hdr }, body: JSON.stringify(body) }).then(j);

const ok = [], bad = [];
const check = (name, cond, detail) => { (cond ? ok : bad).push(name + (detail ? ` — ${detail}` : '')); };

// ---- provision: auth -> workspace (the subject's canon) -> seed graph -> mcp token
const ml = await post('/auth/magic-link', { email: 'alice@example.com' });
const ex = await post('/auth/exchange', { code: ml.b.dev_code });
const AUTH = { authorization: `Bearer ${ex.b.session}` };
check('auth.exchange returns session', !!ex.b.session);

const ws = await post('/workspaces', { name: 'Alice Martin — canon' }, AUTH);
const WS = ws.b.id;
check('workspace created', !!WS, WS);

const now = new Date().toISOString();
const nodes = [
  { id: 'g_ns', type: 'goal', created_at: now, updated_at: now, status: 'active',
    title: 'Land 3 enterprise design-research logos by Q3',
    body: 'North-star: prove Pomegranate in regulated enterprises. Win 3 named enterprise logos in design research by end of Q3.',
    priority: 'north_star', period: 'Q3' },
  { id: 'p_ban', type: 'positioning', created_at: now, updated_at: now, status: 'active',
    body: 'Never describe the product as an "AI assistant". We are a strategy substrate, not an assistant.', kind: 'banned_phrase' },
  { id: 'd_price', type: 'decision', created_at: now, updated_at: now, status: 'active',
    summary: 'The roadmap is enterprise-first, SSO before self-serve',
    body: 'Decided the roadmap is enterprise-first: SSO and audit logs ship before self-serve in 2026.',
    decided_on: '2026-04-01', decided_by: 'Alice', category: 'scope' },
];
for (const n of nodes) { const r = await post(`/workspaces/${WS}/graph`, n, AUTH); check(`seed node ${n.id}`, r.s === 200, `status ${r.s}`); }

const tok = await post(`/workspaces/${WS}/mcp-tokens`, {}, AUTH);
const MCP = { authorization: `Bearer ${tok.b.token}` };
check('mcp token minted', !!tok.b.token);

// ---- CONTRACT A: review_deliverable (the `review` verb)
const deliverable = `Subject: Launch announcement\n\nMeet Pomegranate, your new AI assistant for marketing teams. ` +
  `Self-serve comes first: sign up today and invite your team, no SSO needed.`;
const rev = await post('/mcp/tools/review_deliverable', { content: deliverable, kind: 'campaign' }, MCP);
check('review: 200', rev.s === 200, `got ${rev.s}`);
check('review: has id', !!rev.b?.id);
check('review: findings is array', Array.isArray(rev.b?.findings));
const f0 = rev.b?.findings?.[0];
check('review: finding shape {category,flag,node_id,quote_from_deliverable,summary}',
  !!f0 && ['category','flag','node_id','quote_from_deliverable','summary'].every(k => k in f0),
  f0 ? Object.keys(f0).join(',') : 'no findings');
check('review: integrity — every red cites a real node',
  (rev.b?.findings ?? []).every(f => f.flag !== 'red' || (f.node_id && nodes.some(n => n.id === f.node_id))),
  `flags=[${(rev.b?.findings ?? []).map(f => f.flag)}]`);

// ---- CONTRACT B: query_context as GetContext (doc stuffed into the question slot)
const payloadDoc = `I'm drafting our enterprise sales deck. Here is the current roadmap slide:\n\n` +
  `"Enterprise: self-serve first, SSO and audit logs later in the year. ` +
  `Positioned as the AI assistant that augments your research team."`;
const question = `Which parts of this canon are relevant to the following material, and what do they say?\n\n${payloadDoc}`;
const gc = await post('/mcp/tools/query_context', { question, scope: 'all' }, MCP);
check('getcontext: 200', gc.s === 200, `got ${gc.s}`);
check('getcontext: shape {answer,cited_node_ids,has_answer}',
  gc.b && ['answer','cited_node_ids','has_answer'].every(k => k in gc.b), Object.keys(gc.b ?? {}).join(','));
check('getcontext: has_answer true for relevant payload', gc.b?.has_answer === true, `has_answer=${gc.b?.has_answer}`);
check('getcontext: cites real nodes only', (gc.b?.cited_node_ids ?? []).every(id => nodes.some(n => n.id === id)), `cited=[${gc.b?.cited_node_ids}]`);
check('getcontext: surfaces pricing OR banned-phrase node', (gc.b?.cited_node_ids ?? []).some(id => id === 'd_price' || id === 'p_ban'), `cited=[${gc.b?.cited_node_ids}]`);

// ---- CONTRACT C: GetContext on an irrelevant payload must NOT fabricate
const offTopic = `Which parts of this canon are relevant to the following material, and what do they say?\n\n` +
  `Here is my recipe for sourdough bread: mix flour, water, salt, and starter; ferment 12 hours; bake at 230C.`;
const gc2 = await post('/mcp/tools/query_context', { question: offTopic, scope: 'all' }, MCP);
check('getcontext(offtopic): has_answer=false (no fabrication)', gc2.b?.has_answer === false, `has_answer=${gc2.b?.has_answer}`);

// ---- report
console.log(`PASS ${ok.length}:`); ok.forEach(x => console.log('  ✓ ' + x));
if (bad.length) { console.log(`\nFAIL ${bad.length}:`); bad.forEach(x => console.log('  ✗ ' + x)); }
console.log(bad.length ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(bad.length ? 1 : 0);

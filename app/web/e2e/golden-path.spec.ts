import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../../server/src/phase1/ingest/__fixtures__');

const uniqueEmail = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@acme.test`;

/** Sign in via magic link and create a workspace. Returns once the sidebar is visible. */
async function signInAndCreateWorkspace(page: any, wsName = 'Acme Test Co') {
  await page.goto('/');
  await expect(page.locator('h2', { hasText: 'Pomegranate' })).toBeVisible();
  await page.locator('input[type=email]').fill(uniqueEmail());
  await page.getByRole('button', { name: 'Send link' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('h2', { hasText: 'Directories' })).toBeVisible();
  // Select the Founding profile explicitly; the default profile does not
  // allow `positioning`/`banned_phrase` nodes or the review kinds used later.
  await page.getByRole('button', { name: 'Default' }).click();
  await page.getByRole('button', { name: 'Founding' }).click();
  // Step 1: name the folder, then continue to profile selection.
  await page.locator('input[placeholder="My company"]').fill(wsName);
  await page.getByRole('button', { name: 'Continue' }).click();
  // Step 2: a context profile is preselected; confirm with Create.
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  // Step 3: invite teammates (optional) — skip with Finish.
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.locator('.side-nav')).toBeVisible();
}

/** Click a sidebar entry (Overview, Sources, Curate, Ask & Review, Setup). */
async function go(page: any, label: string) {
  await page.locator('.nav-item', { hasText: label }).click();
}

/** Open the Library. The sidebar no longer has a static "Library" entry — the
 *  workspace's subfolders stand in for it, so open the first subfolder (which
 *  renders the Library's node list scoped to it). */
async function goLibrary(page: any) {
  await page.locator('.nav-subfolder').first().click();
}

async function seedBannedPhraseNode(page: any) {
  const session = await page.evaluate(() => localStorage.getItem('pmg_session'));
  const wsId = await page.evaluate(() => localStorage.getItem('pmg_ws'));
  const ts = '2026-01-01T00:00:00Z';
  const resp = await page.request.post(`/api/workspaces/${wsId}/graph`, {
    headers: { authorization: `Bearer ${session}` },
    data: {
      id: 'pos-banned-synergy',
      type: 'positioning',
      created_at: ts,
      updated_at: ts,
      status: 'active',
      body: 'synergy',
      kind: 'banned_phrase',
    },
  });
  expect(resp.ok()).toBe(true);
  return { session, wsId };
}

// ─── Golden path ─────────────────────────────────────────────────────────────

test('login → onboarding → seed graph → review flags banned phrase → issue MCP token → audit', async ({ page }) => {
  await signInAndCreateWorkspace(page);
  await seedBannedPhraseNode(page);

  // Ask & Review — paste deliverable, see red finding
  await go(page, 'Ask & Review');
  await page.locator('textarea[placeholder="Paste a draft…"]').fill(
    'Our platform delivers synergy across teams.',
  );
  // shadcn Select: open the kind trigger and pick Campaign.
  await page.locator('#review-kind').click();
  await page.getByRole('option', { name: 'campaign' }).click();
  await page.locator('main').getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.locator('h3', { hasText: 'Findings' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.flag-red')).toBeVisible();
  await expect(page.locator('.cite').first()).toContainText('pos-banned-synergy');

  // Setup — issue MCP token
  await go(page, 'Setup');
  await page.getByRole('button', { name: /Issue.*token/i }).click();
  await expect(page.locator('pre.token')).toBeVisible({ timeout: 10_000 });
  const tokenText = (await page.locator('pre.token').textContent())?.trim() ?? '';
  expect(tokenText.length).toBeGreaterThan(20);

  // Setup — audit entries (audit log lives on the same surface)
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText(/sign_in|graph_node_mutated|deliverable_submitted|mcp_token_issued/).first())
    .toBeVisible({ timeout: 10_000 });
});

// ─── Bad-code rejection ──────────────────────────────────────────────────────

test('rejects bad magic-link code with an error message', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=email]').fill(uniqueEmail());
  await page.getByRole('button', { name: 'Send link' }).click();
  await page.locator('input[type=text]').first().fill('definitely-not-a-real-code');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('p', { hasText: /401|expired/i })).toBeVisible({ timeout: 5_000 });
});

// ─── File upload (the surface that hid the 500) ──────────────────────────────

test('Sources → file upload accepts repeated uploads (regression)', async ({ page }) => {
  // Three sequential uploads each run LLM synthesis — needs the 3x budget.
  test.slow();
  await signInAndCreateWorkspace(page, 'UploadCo');
  await go(page, 'Sources');
  // Apps is the default ingest tab now — switch to the file uploader.
  await page.getByRole('tab', { name: /upload file/i }).click();

  // Upload the same workspace twice — the bug we just fixed fired on call #2
  const fileInput = page.locator('input[type=file]');
  await fileInput.setInputFiles({
    name: 'memo-1.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Killing the v1 mobile app. north star.'),
  });
  await expect(page.locator('p.muted.small', { hasText: /candidate/i })).toBeVisible({ timeout: 60_000 });

  await fileInput.setInputFiles({
    name: 'memo-2.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Another decision: killing the legacy SKU.'),
  });
  // Status message updates with new filename
  await expect(page.locator('p.muted.small', { hasText: /memo-2\.txt/ })).toBeVisible({ timeout: 60_000 });

  // .docx fixture
  await fileInput.setInputFiles(path.join(FIXTURES, 'sample.docx'));
  await expect(page.locator('p.muted.small', { hasText: /sample\.docx/ })).toBeVisible({ timeout: 60_000 });
});

test('Sources → apps is the default ingest tab', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'AppsCo');
  await go(page, 'Sources');
  // "From your apps" is selected on arrival — no click needed.
  await expect(page.getByRole('tab', { name: /from your apps/i })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('Sources → file upload rejects unsupported extension with visible error', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'RejectCo');
  await go(page, 'Sources');
  await page.getByRole('tab', { name: /upload file/i }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'image.png',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
  });
  await expect(page.locator('p').filter({ hasText: /415|unsupported/i })).toBeVisible({ timeout: 10_000 });
});

// ─── Ask ─────────────────────────────────────────────────────────────────────

test('Ask → seed-question chip returns an answer with citations', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'MirrorCo');
  await seedBannedPhraseNode(page);

  await go(page, 'Ask');
  // Type a question that the heuristic provider can ground (default target is
  // your own folder, so no teammate needs picking).
  await page
    .locator('input[placeholder^="What\'s the latest"]')
    .fill('what banned phrases do we have');
  await page.locator('main').getByRole('button', { name: 'Get answer', exact: true }).click();
  await expect(page.locator('.answer-box')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.answer-text')).toContainText('synergy');
  await expect(page.locator('.cite-list .cite')).toContainText('pos-banned-synergy');
});

// ─── Reviews tab kind variations ─────────────────────────────────────────────

test('Reviews → kind selector exposes all 6 kinds', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'KindsCo');
  await seedBannedPhraseNode(page);
  await go(page, 'Ask & Review');
  // shadcn Select renders options on open. The founding profile (default for
  // a fresh workspace) exposes exactly these six review kinds; labels render
  // with underscores swapped for spaces.
  await page.locator('#review-kind').click();
  const kindLabels = ['prd', 'exec update', 'campaign', 'sales email', 'deck', 'other'];
  for (const label of kindLabels) {
    await expect(page.getByRole('option', { name: label, exact: true })).toBeVisible();
  }
  // Selecting one closes the listbox and reflects the choice on the trigger.
  await page.getByRole('option', { name: 'campaign', exact: true }).click();
  await expect(page.locator('#review-kind')).toContainText('campaign');
});

// ─── Graph tab ───────────────────────────────────────────────────────────────

test('Library → renders empty-state copy on a fresh workspace', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'GraphCo');
  await goLibrary(page);
  await expect(page.locator('h2', { hasText: 'folders are empty' })).toBeVisible();
});

test('Library → groups seeded nodes by type, shows supersession chain on expand', async ({
  page,
}) => {
  await signInAndCreateWorkspace(page, 'GraphSeedCo');
  const session = await page.evaluate(() => localStorage.getItem('pmg_session'));
  const wsId = await page.evaluate(() => localStorage.getItem('pmg_ws'));
  const post = async (body: any) => {
    const r = await page.request.post(`/api/workspaces/${wsId}/graph`, {
      headers: { authorization: `Bearer ${session}` },
      data: body,
    });
    expect(r.ok()).toBe(true);
  };
  const TS = '2026-01-01T00:00:00Z';
  // Seed nodes spanning all three types + one supersession layer
  await post({
    id: 'goal-q2',
    type: 'goal',
    created_at: TS,
    updated_at: TS,
    status: 'active',
    title: 'Q2 2026 north star: $1M ARR from mid-market design partners',
    body: 'Land 10 partners.',
    priority: 'north_star',
  });
  await post({
    id: 'pos-banned-synergy',
    type: 'positioning',
    created_at: TS,
    updated_at: TS,
    status: 'active',
    body: 'synergy',
    kind: 'banned_phrase',
  });
  // Old decision (will be superseded)
  await post({
    id: 'dec-mobile-old',
    type: 'decision',
    created_at: TS,
    updated_at: TS,
    status: 'archived',
    summary: 'Two-stage rollout',
    body: 'Two stages.',
    decided_on: '2026-01-01',
    category: 'scope',
  });
  // New decision supersedes the old one
  await post({
    id: 'dec-mobile-new',
    type: 'decision',
    created_at: TS,
    updated_at: TS,
    status: 'active',
    summary: 'Three-stage rollout: beta, staff, everyone',
    body: 'Three stages.',
    decided_on: '2026-04-01',
    category: 'scope',
    superseded: 'dec-mobile-old',
  });

  await goLibrary(page);
  // The map is the default view; the category assertions are list-view.
  await page.getByRole('button', { name: 'List', exact: true }).click();

  // Each kind is a full-width, collapsible category section ("Kind · bucket").
  await expect(page.locator('.graph-cat-goal h3')).toContainText('Goals');
  await expect(page.locator('.graph-cat-positioning h3')).toContainText('Positioning');
  await expect(page.locator('.graph-cat-decision h3')).toContainText('Decisions');

  // The header summary mentions the archived supersession layer
  await expect(page.locator('.graph-head .muted')).toContainText('1 archived');

  // The new decision's card hints at the supersession while not expanded
  const supersedingCard = page.locator('.gn-card', { hasText: 'Three-stage rollout' });
  await expect(supersedingCard.locator('.gn-chain-hint')).toBeVisible();

  // Clicking the title expands it, surfacing the chain detail
  await supersedingCard.locator('.gn-summary').click();
  await expect(supersedingCard.locator('.gn-chain-label')).toContainText('Supersedes 1');
  await expect(supersedingCard.locator('.gn-chain-summary')).toContainText('Two-stage');
});

test('Library → filter narrows the visible nodes', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'GraphFilterCo');
  const session = await page.evaluate(() => localStorage.getItem('pmg_session'));
  const wsId = await page.evaluate(() => localStorage.getItem('pmg_ws'));
  const TS = '2026-01-01T00:00:00Z';
  for (const body of ['synergy', 'world-class', 'best-in-class']) {
    const r = await page.request.post(`/api/workspaces/${wsId}/graph`, {
      headers: { authorization: `Bearer ${session}` },
      data: {
        id: `pos-${body.replace(/\W/g, '-')}`,
        type: 'positioning',
        created_at: TS,
        updated_at: TS,
        status: 'active',
        body,
        kind: 'banned_phrase',
      },
    });
    expect(r.ok()).toBe(true);
  }

  await goLibrary(page);
  await expect(page.locator('.gn-card')).toHaveCount(3);
  await page.locator('.graph-filter').fill('class');
  await expect(page.locator('.gn-card')).toHaveCount(2);
  await page.locator('.graph-filter').fill('');
  await expect(page.locator('.gn-card')).toHaveCount(3);
});

// ─── Switch-workspace flow ───────────────────────────────────────────────────

test('Switch workspace button returns to onboarding', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'SwitchCo');
  // Workspace switcher moved into a DropdownMenu (spec A4): open it via the
  // workspace-name trigger in the topbar, then click the "Switch workspace" item.
  await page.locator('header button', { hasText: 'SwitchCo' }).click();
  await page.getByRole('menuitem', { name: 'Switch workspace' }).click();
  await expect(page.locator('h2', { hasText: 'Workspaces' })).toBeVisible();
  await expect(page.locator('ul li button', { hasText: 'SwitchCo' })).toBeVisible();
});

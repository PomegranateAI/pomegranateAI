import { test, expect, type Page } from '@playwright/test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addAgent,
  goNav,
  note,
  openFirstFolder,
  postNode,
  signUpWithDirectory,
  uniqueEmail,
} from './helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../../server/src/phase1/ingest/__fixtures__');

// A directory's one folder uses the built-in Notes template, whose only kind
// is `note`: the banned phrase the review and Ask tests rely on is a note.
const BANNED_NOTE_ID = 'n-banned-synergy';
async function seedBannedPhraseNote(page: Page) {
  await postNode(
    page,
    note(
      BANNED_NOTE_ID,
      'Banned phrase: synergy',
      'Banned phrase: "synergy". We never use the word "synergy" in any external copy — not on the site, ' +
        'not in campaigns, not in sales emails. Rewrite any draft that uses it.',
      { category: 'messaging' },
    ),
  );
}

// ─── Golden path ─────────────────────────────────────────────────────────────

test('login → onboarding → seed graph → feedback flags banned phrase → issue MCP token → audit', async ({ page }) => {
  // One real review call (and its retries on a loaded machine).
  test.setTimeout(150_000);
  await signUpWithDirectory(page, 'Acme Test Co');
  await seedBannedPhraseNote(page);

  // Get feedback — paste a deliverable, see a red finding citing the note.
  await addAgent(page, 'Add collab agent', 'Get feedback');
  await expect(page.getByRole('heading', { name: 'Check your work against the team' })).toBeVisible();
  await page.getByRole('tab', { name: 'Text' }).click();
  await page.getByPlaceholder('Paste the draft, section, or notes to check…').fill(
    'Our platform delivers synergy across teams.',
  );
  await page.getByRole('button', { name: 'Check alignment' }).click();
  await expect(page.getByText(/^Inconsistencies \(\d+\)$/)).toBeVisible({ timeout: 120_000 });
  const redFinding = page.locator('div.rounded-lg.border', { has: page.locator('.flag-red') });
  await expect(redFinding.locator('.cite').first()).toContainText(BANNED_NOTE_ID);

  // Setup → Integrations — issue an MCP connection token.
  await goNav(page, 'Setup');
  await page.getByRole('tab', { name: 'Integrations' }).click();
  await page.getByRole('button', { name: 'Issue connection token' }).click();
  await expect(page.locator('pre.token').last()).toBeVisible({ timeout: 10_000 });
  const tokenText = (await page.locator('pre.token').last().textContent())?.trim() ?? '';
  expect(tokenText.length).toBeGreaterThan(20);

  // Setup → General — the audit log records what just happened.
  await page.getByRole('tab', { name: 'General' }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  for (const event of ['graph_node_mutated', 'mcp_token_issued']) {
    await expect(page.getByText(event, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  }
});

// ─── Bad-code rejection ──────────────────────────────────────────────────────

test('rejects bad magic-link code with an error message', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=email]').fill(uniqueEmail());
  await page.getByRole('button', { name: 'Send link' }).click();
  await page.locator('#login-code').fill('definitely-not-a-real-code');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('p', { hasText: /401|expired/i })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.side-nav')).toHaveCount(0);
});

// ─── File upload (the surface that hid the 500) ──────────────────────────────

test('Sources → file upload accepts repeated uploads (regression)', async ({ page }) => {
  // Three sequential uploads each run LLM synthesis.
  test.setTimeout(240_000);
  await signUpWithDirectory(page, 'UploadCo');
  await goNav(page, 'Add sources');
  // Apps is the default ingest tab now — switch to the file uploader.
  await page.getByRole('tab', { name: /upload file/i }).click();

  // Upload twice — the bug this guards against fired on call #2.
  const fileInput = page.locator('input[type=file]');
  const status = (name: RegExp) => page.locator('p.muted.small', { hasText: name });
  await fileInput.setInputFiles({
    name: 'memo-1.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Killing the v1 mobile app. north star.'),
  });
  await expect(status(/^memo-1\.txt: \d+ candidates? queued/)).toBeVisible({ timeout: 70_000 });

  await fileInput.setInputFiles({
    name: 'memo-2.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Another decision: killing the legacy SKU.'),
  });
  await expect(status(/^memo-2\.txt: \d+ candidates? queued/)).toBeVisible({ timeout: 70_000 });

  // .docx fixture
  await fileInput.setInputFiles(path.join(FIXTURES, 'sample.docx'));
  await expect(status(/^sample\.docx: \d+ candidates? queued/)).toBeVisible({ timeout: 70_000 });
  await expect(page.locator('p.text-destructive')).toHaveCount(0);
});

test('Sources → apps is the default ingest tab', async ({ page }) => {
  await signUpWithDirectory(page, 'AppsCo');
  await goNav(page, 'Add sources');
  // "From your apps" is selected on arrival — no click needed.
  await expect(page.getByRole('tab', { name: /from your apps/i })).toHaveAttribute('aria-selected', 'true');
});

test('Sources → file upload rejects unsupported extension with visible error', async ({ page }) => {
  await signUpWithDirectory(page, 'RejectCo');
  await goNav(page, 'Add sources');
  await page.getByRole('tab', { name: /upload file/i }).click();
  let uploaded = false;
  page.on('request', (r) => {
    if (r.url().includes('/ingest/file')) uploaded = true;
  });
  // Images and audio are read by a folder's media agents (media-reader-gate
  // spec); an archive is something nothing can read.
  await page.locator('input[type=file]').setInputFiles({
    name: 'bundle.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  });
  await expect(page.locator('p.text-destructive', { hasText: 'bundle.zip: this file type can’t be read' })).toBeVisible();
  expect(uploaded).toBe(false);
});

// ─── Ask ─────────────────────────────────────────────────────────────────────

test('Ask → question returns an answer with citations', async ({ page }) => {
  test.setTimeout(120_000);
  await signUpWithDirectory(page, 'MirrorCo');
  await seedBannedPhraseNote(page);

  await goNav(page, 'Ask the team');
  // The default target is your own directory, so no teammate needs picking.
  await page.getByPlaceholder(/^What's the latest/).fill('what banned phrases do we have');
  await page.locator('main').getByRole('button', { name: 'Get answer', exact: true }).click();
  await expect(page.locator('.answer-box')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('.answer-text')).toContainText('synergy');
  await expect(page.locator('.cite-list .cite')).toContainText(BANNED_NOTE_ID);
});

// ─── Get feedback form ───────────────────────────────────────────────────────
// (Replaces "kind selector exposes all 6 kinds": the review-kind selector went
// away with the Founding template; the feedback form now takes a deliverable
// as a file, a link, or text, and checks it against chosen directories.)

test('Get feedback → check needs both a deliverable and a directory to check against', async ({ page }) => {
  await signUpWithDirectory(page, 'KindsCo');
  await addAgent(page, 'Add collab agent', 'Get feedback');
  const check = page.getByRole('button', { name: 'Check alignment' });

  // Upload is the default input; nothing chosen yet.
  await expect(page.getByRole('tab', { name: 'Upload' })).toHaveAttribute('aria-selected', 'true');
  await expect(check).toBeDisabled();

  await page.getByRole('tab', { name: 'Link' }).click();
  await page.getByPlaceholder(/link to a doc, deck, or page/).fill('https://example.com/plan');
  await expect(check).toBeEnabled();

  await page.getByRole('tab', { name: 'Text' }).click();
  await expect(check).toBeDisabled();
  await page.getByPlaceholder('Paste the draft, section, or notes to check…').fill('Draft copy.');
  await expect(check).toBeEnabled();

  // This directory is the default target; removing it leaves nothing to check against.
  await page.getByRole('button', { name: /This directory/ }).click();
  await expect(check).toBeDisabled();
  await page.getByRole('button', { name: /This directory/ }).click();
  await expect(check).toBeEnabled();
});

// ─── Folder (Library) list ───────────────────────────────────────────────────

test('Library → renders empty-state copy on a fresh workspace', async ({ page }) => {
  await signUpWithDirectory(page, 'GraphCo');
  await openFirstFolder(page);
  await expect(page.locator('h2', { hasText: 'folders are empty' })).toBeVisible();
});

test('Library → a replaced note is hidden until shown, and points at its replacement', async ({ page }) => {
  await signUpWithDirectory(page, 'GraphSeedCo');
  await postNode(page, note('n-goal', 'Q2 north star', 'Land 10 mid-market design partners.', { category: 'goal' }));
  await postNode(page, note('n-rollout-new', 'Three-stage rollout: beta, staff, everyone', 'Three stages.', { category: 'decision' }));
  // The old note is archived and names its successor.
  await postNode(page, {
    ...note('n-rollout-old', 'Two-stage rollout', 'Two stages.', { category: 'decision' }),
    status: 'archived',
    superseded: 'n-rollout-new',
  });

  await openFirstFolder(page);
  await expect(page.locator('.graph-head')).toBeVisible();
  const card = (title: string) => page.locator('.gn-card', { hasText: title });

  // Only what currently holds is listed by default.
  await expect(page.locator('.gn-card')).toHaveCount(2);
  await expect(card('Two-stage rollout')).toHaveCount(0);

  // View › Replaced versions brings the old one back, marked as replaced.
  await page.locator('.graph-view-menu').click();
  await page.getByRole('menuitemcheckbox', { name: 'Replaced versions' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.gn-card')).toHaveCount(3);
  const replaced = card('Two-stage rollout').locator('.gn-superseded');
  await expect(replaced).toHaveText('Replaced');
  await expect(card('Three-stage rollout').locator('.gn-superseded')).toHaveCount(0);

  // Its "Replaced" chip jumps to (and opens) the replacement.
  await expect(card('Three-stage rollout')).toHaveAttribute('aria-expanded', 'false');
  await replaced.click();
  await expect(card('Three-stage rollout')).toHaveAttribute('aria-expanded', 'true');
});

test('Library → filter narrows the visible nodes', async ({ page }) => {
  await signUpWithDirectory(page, 'GraphFilterCo');
  for (const phrase of ['synergy', 'world-class', 'best-in-class']) {
    await postNode(page, note(`n-${phrase}`, `Banned phrase: ${phrase}`, `Never say "${phrase}".`, { category: 'messaging' }));
  }

  await openFirstFolder(page);
  await expect(page.locator('.gn-card')).toHaveCount(3);
  await page.locator('.graph-filter').fill('class');
  await expect(page.locator('.gn-card')).toHaveCount(2);
  await page.locator('.graph-filter').fill('');
  await expect(page.locator('.gn-card')).toHaveCount(3);
});

// ─── Switch-directory flow ───────────────────────────────────────────────────

test('Switch directory returns to the directory picker', async ({ page }) => {
  await signUpWithDirectory(page, 'SwitchCo');
  // The switcher is a dropdown on the directory name in the header.
  await page.locator('header').getByRole('button', { name: 'SwitchCo' }).click();
  await page.getByRole('menuitem', { name: 'Switch directory' }).click();
  await expect(page.getByRole('heading', { name: 'Directories' })).toBeVisible();
  await expect(page.locator('.side-nav')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'SwitchCo', exact: true })).toBeVisible();
});

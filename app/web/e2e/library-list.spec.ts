import { test, expect } from '@playwright/test';

// Exercises the full-width, collapsible-category List view (Graph.tsx): the
// 3-state node rows (collapsed / preview / expanded), expand-all / collapse-all,
// the full-screen node dialog, and the WikiEditor-backed body editing that
// round-trips through POST /graph. Uses the Default (whole-doc) profile, whose
// `note` kind buckets by the inferred `attrs.category`.

const uniqueEmail = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@acme.test`;

async function signInAndCreateDefaultFolder(page: any, wsName = 'ListCo') {
  await page.goto('/');
  await expect(page.locator('h2', { hasText: 'Pomegranate' })).toBeVisible();
  await page.locator('input[type=email]').fill(uniqueEmail());
  await page.getByRole('button', { name: 'Send link' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('h2', { hasText: 'Directories' })).toBeVisible();
  // Name the directory and create it — the first profile (Notes) is
  // preselected, so there is no profile step and no card click.
  await page.locator('input[placeholder="My company"]').fill(wsName);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.side-nav')).toBeVisible({ timeout: 20_000 });
}

const TS = '2026-01-01T00:00:00Z';
const LONG_BODY = Array.from({ length: 9 }, (_, i) => `Line ${i + 1} of the note body.`).join('\n');

async function seedNotes(page: any) {
  const session = await page.evaluate(() => localStorage.getItem('pmg_session'));
  const wsId = await page.evaluate(() => localStorage.getItem('pmg_ws'));
  const post = async (body: any) => {
    const r = await page.request.post(`/api/workspaces/${wsId}/graph`, {
      headers: { authorization: `Bearer ${session}` },
      data: body,
    });
    expect(r.ok(), await r.text()).toBe(true);
  };
  const note = (id: string, title: string, category: string, body: string) => ({
    id,
    type: 'note',
    created_at: TS,
    updated_at: TS,
    status: 'active',
    title,
    body,
    attrs: { category },
  });
  await post(note('n-comp-1', 'OpenAI overview', 'competitor', LONG_BODY));
  await post(note('n-comp-2', 'Anthropic overview', 'competitor', 'Short competitor note.'));
  await post(note('n-scope-1', 'Release checklist', 'scope', 'Line one\nLine two\nLine three'));
  return { session, wsId };
}

async function openList(page: any) {
  // Opening a folder lands on the list; there is no separate List tab.
  await page.locator('.nav-subfolder').first().click();
  await expect(page.locator('.graph-head')).toBeVisible();
}

test('List → full-width category sections with counts, collapse/expand', async ({ page }) => {
  await signInAndCreateDefaultFolder(page);
  await seedNotes(page);
  await openList(page);

  // Two category sections under the single `note` kind, each full-width.
  const competitor = page.locator('.graph-cat-note', { hasText: 'competitor' });
  const scopeGroup = page.locator('.graph-cat-note', { hasText: 'scope' });
  await expect(competitor).toBeVisible();
  await expect(scopeGroup).toBeVisible();
  await expect(competitor.locator('h3')).toContainText('Notes');

  // The category header shows its item count (2 competitor notes).
  await expect(competitor.locator('header')).toContainText('2');

  // Every expanded subcategory shows its own Share control (not just the first).
  await expect(competitor.locator('.gn-group-priv')).toBeVisible();
  await expect(scopeGroup.locator('.gn-group-priv')).toBeVisible();

  // Both competitor cards are visible; collapsing the category hides them AND
  // the Share control (it only shows while expanded).
  await expect(competitor.locator('.gn-card')).toHaveCount(2);
  await competitor.locator('header button').first().click();
  await expect(competitor.locator('.gn-card')).toHaveCount(0);
  await expect(competitor.locator('.gn-group-priv')).toHaveCount(0);
  await competitor.locator('header button').first().click();
  await expect(competitor.locator('.gn-card')).toHaveCount(2);
  await expect(competitor.locator('.gn-group-priv')).toBeVisible();
});

test('List → node preview clamps, expands to editor, and collapses to title', async ({ page }) => {
  await signInAndCreateDefaultFolder(page);
  await seedNotes(page);
  await openList(page);

  const card = page.locator('.gn-card', { hasText: 'OpenAI overview' });

  // Default state = preview: a clamped body + a "Show more" affordance.
  await expect(card.locator('.gn-preview')).toBeVisible();
  await expect(card.locator('.gn-preview')).toContainText('Line 1 of the note body.');

  // Clicking the title expands it → the WikiEditor surface appears.
  await card.locator('.gn-summary').click();
  await expect(card.locator('.wiki-editor')).toBeVisible();
  await expect(card.locator('.gn-preview')).toHaveCount(0);

  // The chevron collapses to title-only (no preview, no editor).
  await card.locator('.gn-chevron').click();
  await expect(card.locator('.gn-preview')).toHaveCount(0);
  await expect(card.locator('.wiki-editor')).toHaveCount(0);
});

test('List → expand-all and collapse-all drive every node', async ({ page }) => {
  await signInAndCreateDefaultFolder(page);
  await seedNotes(page);
  await openList(page);

  // Expand/collapse moved out of the header strip into the View menu.
  // Radix keeps `pointer-events: none` on the body while a menu is closing, so
  // each reopen waits for the previous menu to actually go away first.
  await page.locator('.graph-view-menu').click();
  await page.getByRole('menuitem', { name: 'Expand all' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('.wiki-editor')).toHaveCount(3);

  await page.locator('.graph-view-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Collapse all' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Collapse all' }).click();
  await expect(page.locator('.wiki-editor')).toHaveCount(0);
  await expect(page.locator('.gn-preview')).toHaveCount(0);
});

test('List → full-screen dialog opens the node with its editor', async ({ page }) => {
  await signInAndCreateDefaultFolder(page);
  await seedNotes(page);
  await openList(page);

  const card = page.locator('.gn-card', { hasText: 'Release checklist' });
  await card.locator('.gn-fullscreen').click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Release checklist')).toBeVisible();
  await expect(dialog.locator('.wiki-editor')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('List → editing a node body persists through a reload', async ({ page }) => {
  await signInAndCreateDefaultFolder(page);
  await seedNotes(page);
  await openList(page);

  const card = page.locator('.gn-card', { hasText: 'Anthropic overview' });
  await card.locator('.gn-summary').click();
  const prose = card.locator('.wiki-prose');
  await expect(prose).toBeVisible();

  // Append text, then blur to flush the debounced autosave.
  await prose.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' EDITED-BY-E2E');
  await page.locator('.graph-title').click(); // blur the editor → flush save
  await page.waitForTimeout(1200);

  // Reload: the edited body must come back from the server. Reopen the List.
  await page.reload();
  await expect(page.locator('.side-nav')).toBeVisible();
  await openList(page);
  const reloaded = page.locator('.gn-card', { hasText: 'Anthropic overview' });
  await reloaded.locator('.gn-summary').click();
  await expect(reloaded.locator('.wiki-prose')).toContainText('EDITED-BY-E2E');
});

import { test, expect, type Page } from '@playwright/test';
import { note, openFirstFolder, postNode, signUpWithDirectory } from './helpers';

// Exercises the full-width, collapsible-category List view (Graph.tsx): the
// 3-state node rows (collapsed / preview / expanded), expand-all / collapse-all,
// the full-screen node dialog, and the WikiEditor-backed body editing that
// round-trips through POST /graph. Uses the built-in Notes template, whose one
// kind, `note`, buckets by `attrs.category`.

const LONG_BODY = Array.from({ length: 9 }, (_, i) => `Line ${i + 1} of the note body.`).join('\n');

async function seedNotes(page: Page) {
  await postNode(page, note('n-comp-1', 'OpenAI overview', LONG_BODY, { category: 'competitor' }));
  await postNode(page, note('n-comp-2', 'Anthropic overview', 'Short competitor note.', { category: 'competitor' }));
  await postNode(page, note('n-scope-1', 'Release checklist', 'Line one\nLine two\nLine three', { category: 'scope' }));
}

async function openList(page: Page) {
  // Opening a folder lands on the list; there is no separate List tab.
  await openFirstFolder(page);
  await expect(page.locator('.graph-head')).toBeVisible();
}

test('List → full-width category sections with counts, collapse/expand', async ({ page }) => {
  await signUpWithDirectory(page, 'ListCo');
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
  await signUpWithDirectory(page, 'ListCo');
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
  await signUpWithDirectory(page, 'ListCo');
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
  await signUpWithDirectory(page, 'ListCo');
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
  await signUpWithDirectory(page, 'ListCo');
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

import { test, expect, type Page } from '@playwright/test';
import { addAgent, catalogTile, signUpWithDirectory } from './helpers';

// Agents in the sidebar are opt-in: each group (Collab agents, Work agents)
// has its own catalog, and an added agent can be hidden again. (This file used
// to cover the custom-agent builder — "New agent", context notes, examples, a
// test panel — which was removed from the product.)

const WORK_AGENTS = ['Draft', 'Synthesize', 'Catch-up', 'Follow-up', 'Give updates'];
const COLLAB_AGENTS = ['Get updates', 'Get feedback'];

const navItem = (page: Page, label: string) => page.locator('.side-nav .nav-item', { hasText: label });

test('Agents → each group has its own catalog; a fresh directory has none added', async ({ page }) => {
  await signUpWithDirectory(page, 'AgentCatalogCo');

  for (const label of [...WORK_AGENTS, ...COLLAB_AGENTS]) {
    await expect(navItem(page, label)).toHaveCount(0);
  }

  // Work agents catalog: all five, none added yet, and no collab agents.
  await page.getByRole('button', { name: 'Add work agent' }).first().click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Add a work agent' })).toBeVisible();
  for (const label of WORK_AGENTS) {
    await expect(catalogTile(page, label).getByRole('button', { name: 'Add' })).toBeVisible();
  }
  for (const label of COLLAB_AGENTS) {
    await expect(catalogTile(page, label)).toHaveCount(0);
  }
  await page.keyboard.press('Escape');

  // Collab agents catalog: the other two.
  await page.getByRole('button', { name: 'Add collab agent' }).first().click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Add a collab agent' })).toBeVisible();
  for (const label of COLLAB_AGENTS) {
    await expect(catalogTile(page, label).getByRole('button', { name: 'Add' })).toBeVisible();
  }
  for (const label of WORK_AGENTS) {
    await expect(catalogTile(page, label)).toHaveCount(0);
  }
});

test('Agents → add a work agent, it persists across reload, hide it again', async ({ page }) => {
  await signUpWithDirectory(page, 'AgentAddCo');

  await addAgent(page, 'Add work agent', 'Draft');
  await expect(page.locator('main h1', { hasText: 'Draft' })).toBeVisible();

  // Saved server-side, per directory: still there after a reload.
  await page.reload();
  await expect(navItem(page, 'Draft')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Add work agent' }).first().click();
  await expect(catalogTile(page, 'Draft').getByText('Added')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Hide it: the cross is revealed on hover.
  await navItem(page, 'Draft').hover();
  await page.getByRole('button', { name: 'Hide Draft' }).click();
  await expect(navItem(page, 'Draft')).toHaveCount(0);

  // Hidden is saved too, and the catalog offers it again.
  await page.reload();
  await expect(page.locator('.side-nav')).toBeVisible({ timeout: 20_000 });
  await expect(navItem(page, 'Draft')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add work agent' }).first().click();
  await expect(catalogTile(page, 'Draft').getByRole('button', { name: 'Add' })).toBeVisible();
});

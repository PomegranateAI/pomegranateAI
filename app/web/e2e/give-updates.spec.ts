import { test, expect } from '@playwright/test';

// The Give-updates work agent: broadcast updates about your own folder to a
// list of teammates, with the list saveable and reusable. It's the Updates view
// in 'give' mode, so this drives the parts that differ from Get updates — the
// recipient chips, the saved list, and the own-folder-only scope.

const uniqueEmail = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@acme.test`;

async function signInAndCreateWorkspace(page: any, wsName = 'Broadcast Co') {
  await page.goto('/');
  await expect(page.locator('h2', { hasText: 'Pomegranate' })).toBeVisible();
  await page.locator('input[type=email]').fill(uniqueEmail());
  await page.getByRole('button', { name: 'Send link' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('h2', { hasText: 'Directories' })).toBeVisible();
  await page.locator('input[placeholder="My company"]').fill(wsName);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.locator('.side-nav')).toBeVisible();
}

/** Agents are opt-in: add one from its group's catalog, then open it. */
async function addAgent(page: any, addLabel: string, label: string) {
  await page.getByRole('button', { name: addLabel }).first().click();
  // Each catalog tile is a label + its own "Add" button.
  const tile = page.getByRole('dialog').locator('div.bg-card').filter({ hasText: label });
  await tile.getByRole('button', { name: 'Add' }).click();
  await page.keyboard.press('Escape');
  await page.locator('.nav-item', { hasText: label }).click();
}

test('Give updates → broadcast to many recipients, save the list, reuse it', async ({ page }) => {
  await signInAndCreateWorkspace(page);
  await addAgent(page, 'Add work agent', 'Give updates');

  await expect(page.locator('h1', { hasText: 'Keep your team posted on your work' })).toBeVisible();

  // ── Create a broadcast ────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'New broadcast' }).click();
  await page.locator('textarea').first().fill('what I shipped this week');

  // A broadcast reports on your own folder — no folder/teammate scope picker.
  await expect(page.getByText('Add directory or teammate')).toHaveCount(0);
  await expect(page.getByText('Reported from your own folder only', { exact: false })).toBeVisible();

  // Recipients: a typed address, plus a pasted block that splits into chips.
  await page.getByRole('button', { name: 'Add teammate' }).click();
  await page.getByPlaceholder('name@company.com').fill('ana@acme.test');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByPlaceholder('name@company.com').fill('bo@acme.test, cy@acme.test');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.keyboard.press('Escape');
  for (const addr of ['ana@acme.test', 'bo@acme.test', 'cy@acme.test']) {
    await expect(page.getByText(addr, { exact: true })).toBeVisible();
  }

  // ── Save those recipients as a reusable, named list ───────────────────────
  await page.getByRole('button', { name: /Save these 3 as a list/ }).click();
  await page.getByPlaceholder(/Name this list/).fill('Design team');
  await page.getByRole('button', { name: 'Save list' }).click();
  await expect(page.getByText('Saved “Design team”.')).toBeVisible();

  // It defaults to holding for approval — it goes out under your name.
  await expect(page.getByText('Ask me to approve first')).toBeVisible();

  await page.getByRole('button', { name: 'Create broadcast' }).click();

  // ── It's listed, with its recipient count ────────────────────────────────
  await expect(page.getByText('Your broadcasts')).toBeVisible();
  await expect(page.getByText('what I shipped this week')).toBeVisible();
  await expect(page.getByText('3 recipients')).toBeVisible();

  // ── The saved list is reusable on the next broadcast ─────────────────────
  await page.getByRole('button', { name: 'New broadcast' }).click();
  await page.locator('textarea').first().fill('my quarterly wrap-up');
  await page.getByRole('button', { name: 'Add teammate' }).click();
  await page.getByRole('menuitem', { hasText: 'Design team' }).click();
  for (const addr of ['ana@acme.test', 'bo@acme.test', 'cy@acme.test']) {
    await expect(page.getByText(addr, { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Create broadcast' }).click();
  await expect(page.getByText('my quarterly wrap-up')).toBeVisible();

  // ── The two agents keep separate lists ───────────────────────────────────
  // A broadcast about my work must not show up as a topic I follow.
  await addAgent(page, 'Add collab agent', 'Get updates');
  await expect(page.locator('h1', { hasText: 'Stay posted on what moves' })).toBeVisible();
  await expect(page.getByText('what I shipped this week')).toHaveCount(0);
  await expect(page.getByText('No watches yet', { exact: false })).toBeVisible();
});

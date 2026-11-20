import { test, expect } from '@playwright/test';

const uniqueEmail = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@acme.test`;

/** Sign in via magic link and create a workspace (Founding-team default subfolder). */
async function signInAndCreateWorkspace(page: any, wsName: string) {
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

test('Sidebar → add and rename a subfolder', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'SubfolderCo');
  // Starts with exactly one subfolder — the default, named after the profile.
  await expect(page.locator('.nav-subfolder')).toHaveCount(1);
  await expect(page.locator('.nav-subfolder').first()).toContainText('Founding team');

  // Add a subfolder: pick a profile, name it, create.
  await page.getByRole('button', { name: 'Add folder' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New folder' })).toBeVisible();
  await dialog.getByRole('button').filter({ hasText: 'Product' }).first().click();
  await dialog.locator('#subfolder-name').fill('QA Space');
  await dialog.getByRole('button', { name: /Create folder/ }).click();

  // The new subfolder appears in the sidebar and becomes the second row.
  await expect(page.locator('.nav-subfolder', { hasText: 'QA Space' })).toBeVisible();
  await expect(page.locator('.nav-subfolder')).toHaveCount(2);

  // Rename it inline via the pencil affordance.
  await page.getByRole('button', { name: 'Rename QA Space' }).click({ force: true });
  const input = page.locator('input[aria-label="Rename QA Space"]');
  await input.fill('QA Renamed');
  await input.press('Enter');
  await expect(page.locator('.nav-subfolder', { hasText: 'QA Renamed' })).toBeVisible();
  await expect(page.locator('.nav-subfolder', { hasText: 'QA Space' })).toHaveCount(0);
});

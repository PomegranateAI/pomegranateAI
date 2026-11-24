import { test, expect } from '@playwright/test';
import { signUpWithDirectory } from './helpers';

test('Sidebar → add and rename a subfolder', async ({ page }) => {
  await signUpWithDirectory(page, 'SubfolderCo');
  // Starts with exactly one subfolder — the default, named after the one
  // built-in template (Notes).
  await expect(page.locator('.nav-subfolder')).toHaveCount(1);
  await expect(page.locator('.nav-subfolder').first()).toContainText('Notes');

  // Add a subfolder: name it, create. There is only one template, so the
  // dialog has no template picker.
  await page.getByRole('button', { name: 'Add folder' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New folder' })).toBeVisible();
  await dialog.locator('#subfolder-name').fill('QA Space');
  await dialog.getByRole('button', { name: /Create folder/ }).click();
  await expect(dialog).toHaveCount(0);

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

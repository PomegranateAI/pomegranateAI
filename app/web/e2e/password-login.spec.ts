import { test, expect } from '@playwright/test';

const uniqueEmail = () => `e2e-pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@acme.test`;

/** Sign in via magic link only — no workspace/onboarding needed for these
 *  tests, so stop as soon as the sidebar (Setup reachable) is visible. */
async function signInViaMagicLink(page: any, email: string) {
  await page.goto('/');
  await expect(page.locator('h2', { hasText: 'Pomegranate' })).toBeVisible();
  await page.locator('input[type=email]').fill(email);
  await page.getByRole('button', { name: 'Send link' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('h2', { hasText: 'Directories' })).toBeVisible();
}

async function createWorkspace(page: any, wsName: string) {
  await page.locator('input[placeholder="My company"]').fill(wsName);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.side-nav')).toBeVisible({ timeout: 15_000 });
}

/** After any sign-in (magic link or password) a fresh session has no
 *  workspace selected yet — even for an account that already has one — so
 *  it lands on the folder picker. Click the folder to actually enter it. */
async function enterFolder(page: any, wsName: string) {
  await page.getByRole('button', { name: wsName }).click();
  await expect(page.locator('.side-nav')).toBeVisible({ timeout: 15_000 });
}

async function goSetup(page: any) {
  await page.locator('.nav-item', { hasText: 'Setup' }).click();
  // CardTitle renders a <div>, not a heading element, so no "heading" role.
  await expect(page.getByText('Password', { exact: true })).toBeVisible();
}

test.describe('password sign-in (alongside magic link)', () => {
  test('full round trip: set → log out → sign in with password → wrong password rejected', async ({ page }) => {
    const email = uniqueEmail();
    await signInViaMagicLink(page, email);
    await createWorkspace(page, 'Acme Password Co');

    await goSetup(page);
    await expect(page.getByText('No password set yet')).toBeVisible();

    await page.locator('#setup-pw-new').fill('lantern orbit cedar 42');
    await page.locator('#setup-pw-confirm').fill('lantern orbit cedar 42');
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByText('Password set')).toBeVisible();
    // Card flips to "change" mode once a password exists.
    await expect(page.getByRole('button', { name: 'Update password' })).toBeVisible();

    // Log out.
    await page.locator('.nav-logout').click();
    await expect(page.locator('h2', { hasText: 'Pomegranate' })).toBeVisible();

    // Wrong password first — must be rejected, not silently accepted.
    await page.getByText('Use a password instead').click();
    await page.locator('#login-email-pw').fill(email);
    await page.locator('#login-password').fill('totally the wrong password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    // The message shows up to two places (inline + toast) — the inline one
    // is the stable assertion target.
    await expect(page.locator('p.text-destructive', { hasText: 'Wrong email or password.' })).toBeVisible();
    // Still on the login screen — no session was granted.
    await expect(page.locator('h2', { hasText: 'Pomegranate' })).toBeVisible();

    // Correct password signs in for real.
    await page.locator('#login-password').fill('lantern orbit cedar 42');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await enterFolder(page, 'Acme Password Co');

    // The session this minted is a real one, on the actual account — Setup
    // still shows the workspace created earlier under the magic-link session.
    await goSetup(page);
    await expect(page.getByRole('button', { name: 'Update password' })).toBeVisible();
  });

  test('changing an existing password requires the current one, in the real UI', async ({ page }) => {
    const email = uniqueEmail();
    await signInViaMagicLink(page, email);
    await createWorkspace(page, 'Acme Rotate Co');
    await goSetup(page);

    const fillAndSave = async (current: string | null, next: string, confirm: string) => {
      if (current !== null) {
        await page.locator('#setup-pw-current').fill(current);
      }
      await page.locator('#setup-pw-new').fill(next);
      await page.locator('#setup-pw-confirm').fill(confirm);
    };

    await fillAndSave(null, 'first password value here', 'first password value here');
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByText('Password set')).toBeVisible();

    // Now the card requires "Current password" — wrong value is rejected.
    await fillAndSave('nope nope nope', 'second password value here', 'second password value here');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByText('Current password is incorrect')).toBeVisible();

    // Right current password rotates it.
    await fillAndSave('first password value here', 'second password value here', 'second password value here');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByText('Password updated')).toBeVisible();

    // Confirm the rotation actually took by signing in with the new value.
    await page.locator('.nav-logout').click();
    await page.getByText('Use a password instead').click();
    await page.locator('#login-email-pw').fill(email);
    await page.locator('#login-password').fill('second password value here');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await enterFolder(page, 'Acme Rotate Co');
  });

  test('magic link keeps working for an account that also has a password', async ({ page }) => {
    const email = uniqueEmail();
    await signInViaMagicLink(page, email);
    await createWorkspace(page, 'Acme Both Co');
    await goSetup(page);
    await page.locator('#setup-pw-new').fill('a real password value');
    await page.locator('#setup-pw-confirm').fill('a real password value');
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByText('Password set')).toBeVisible();

    await page.locator('.nav-logout').click();
    // Default stage is magic link — sign in that way even though a password
    // now exists for this account, proving the two paths coexist.
    await page.locator('input[type=email]').fill(email);
    await page.getByRole('button', { name: 'Send link' }).click();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await enterFolder(page, 'Acme Both Co');
  });
});

import { test, expect } from '@playwright/test';

const uniqueEmail = () => `e2e-mfa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@acme.test`;
const PASSWORD = 'lantern orbit cedar 42';

async function magicLink(page: any, email: string) {
  await page.goto('/');
  await expect(page.locator('h2', { hasText: 'Pomegranate' })).toBeVisible();
  await page.locator('input[type=email]').fill(email);
  await page.getByRole('button', { name: 'Send link' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function passwordLogin(page: any, email: string) {
  await page.getByText('Use a password instead').click();
  await page.locator('#login-email-pw').fill(email);
  await page.locator('#login-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('two-step sign-in (password + emailed link)', () => {
  test('turn on in Setup → password asks for the emailed link → link signs in; magic link alone is refused', async ({ page }) => {
    const email = uniqueEmail();
    await magicLink(page, email);
    await page.locator('input[placeholder="My company"]').fill('Acme MFA Co');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('.side-nav')).toBeVisible({ timeout: 15_000 });

    await page.locator('.nav-item', { hasText: 'Setup' }).click();
    await page.locator('#setup-pw-new').fill(PASSWORD);
    await page.locator('#setup-pw-confirm').fill(PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByText('Password set')).toBeVisible();
    await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
    await expect(page.getByText(/^On\. After your password, we email you a link/)).toBeVisible();

    await page.locator('.nav-logout').click();

    // The magic link alone no longer signs in: it points at the password.
    await magicLink(page, email);
    await expect(page.getByText('Your account uses two-step sign-in')).toBeVisible();

    // Password → "check your email". Dev mode (no mailer) offers the link.
    await page.getByRole('button', { name: 'Use a magic link instead' }).click();
    await passwordLogin(page, email);
    await expect(page.getByTestId('mfa-check-email')).toBeVisible();
    await page.getByRole('button', { name: 'Open link (dev mode)' }).click();
    // Signed in: lands on the folder picker.
    await page.getByRole('button', { name: 'Acme MFA Co' }).click();
    await expect(page.locator('.side-nav')).toBeVisible({ timeout: 15_000 });
  });
});

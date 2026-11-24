import { test, expect, type Page } from '@playwright/test';
import { expectInDirectory, goNav, signUpWithDirectory, submitMagicLink } from './helpers';

const PASSWORD = 'lantern orbit cedar 42';

async function passwordLogin(page: Page, email: string) {
  await page.getByText('Use a password instead').click();
  await page.locator('#login-email-pw').fill(email);
  await page.locator('#login-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('two-step sign-in (password + emailed link)', () => {
  test('turn on in Setup → password asks for the emailed link → link signs in; magic link alone is refused', async ({ page }) => {
    const email = await signUpWithDirectory(page, 'Acme MFA Co', 'e2e-mfa');

    await goNav(page, 'Setup');
    await page.locator('#setup-pw-new').fill(PASSWORD);
    await page.locator('#setup-pw-confirm').fill(PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();
    // Exact: the card's own "No password set yet" must not satisfy this
    // before the save lands, or "Turn on" races ahead of the password.
    await expect(page.getByText('Password set', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
    await expect(page.getByText('Two-step sign-in turned on', { exact: true })).toBeVisible();
    await expect(page.getByText(/^On\. After your password, we email you a link/)).toBeVisible();

    await page.locator('.nav-logout').click();

    // The magic link alone no longer signs in: it points at the password.
    await submitMagicLink(page, email);
    await expect(page.getByText('Your account uses two-step sign-in')).toBeVisible();

    // Password → "check your email". Dev mode (no mailer) offers the link.
    await page.getByRole('button', { name: 'Use a magic link instead' }).click();
    await passwordLogin(page, email);
    await expect(page.getByTestId('mfa-check-email')).toBeVisible();
    await page.getByRole('button', { name: 'Open link (dev mode)' }).click();
    // Signed in: the account's one directory opens directly.
    await expectInDirectory(page, 'Acme MFA Co');
  });
});

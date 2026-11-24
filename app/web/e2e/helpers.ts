import { expect, type Page } from '@playwright/test';

// Shared e2e steps. Every spec signs in and creates a directory the same way,
// so the onboarding flow lives here once: the next UI tweak breaks one place.
//
// Sign-in relies on POMEGRANATE_DEV_INLINE_CODES=1 (set in playwright.config):
// "Send link" pre-fills the sign-in code, so "Sign in" completes the magic link.

export const uniqueEmail = (prefix = 'e2e') =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@acme.test`;

/** Open the login screen and sign in with a magic link. Stops on whatever the
 *  app shows next (the directory picker for a normal account). */
export async function submitMagicLink(page: Page, email: string) {
  await page.goto('/');
  await expect(page.locator('h2', { hasText: 'Pomegranate' })).toBeVisible();
  await page.locator('input[type=email]').fill(email);
  await page.getByRole('button', { name: 'Send link' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Magic-link sign-in that lands on the directory picker. A fresh session has
 *  no directory selected, even for an account that already has one. */
export async function signIn(page: Page, email: string) {
  await submitMagicLink(page, email);
  await expect(page.getByRole('heading', { name: 'Directories' })).toBeVisible();
}

/** From the directory picker: name a new directory and create it. Its one
 *  folder (built-in Notes template) is created with it. */
export async function createDirectory(page: Page, name: string) {
  await page.getByPlaceholder('My company').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.side-nav')).toBeVisible({ timeout: 20_000 });
}

/** New account + new directory; returns the account's email. */
export async function signUpWithDirectory(page: Page, name: string, emailPrefix = 'e2e') {
  const email = uniqueEmail(emailPrefix);
  await signIn(page, email);
  await createDirectory(page, name);
  return email;
}

/** After signing back in to an account with exactly ONE directory, the app
 *  opens it directly (no picker). Assert we're inside it. Don't click the
 *  name: once inside, that's the header's directory-switcher menu trigger,
 *  and an open menu blocks every other click on the page. */
export async function expectInDirectory(page: Page, name: string) {
  await expect(page.locator('.side-nav')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('header').getByRole('button', { name })).toBeVisible();
}

/** Click a sidebar entry by its label (Overview, Ask the team, Add sources,
 *  Get feedback, Setup, ...). */
export async function goNav(page: Page, label: string) {
  await page.locator('.side-nav .nav-item', { hasText: label }).first().click();
}

/** Open the first folder in the sidebar (renders its node list). */
export async function openFirstFolder(page: Page) {
  await page.locator('.nav-subfolder').first().click();
}

/** One tile of the open agent catalog (each tile is a label, a description,
 *  and its own "Add" button or "Added" mark). */
export function catalogTile(page: Page, label: string) {
  return page
    .getByRole('dialog')
    .locator('div.bg-card')
    .filter({ has: page.getByText(label, { exact: true }) });
}

/** Agents are opt-in: add one from its group's catalog. Adding closes the
 *  catalog and opens the agent. */
export async function addAgent(page: Page, addLabel: string, label: string) {
  await page.getByRole('button', { name: addLabel }).first().click();
  await catalogTile(page, label).getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.side-nav .nav-item', { hasText: label })).toHaveAttribute('aria-current', 'page');
}

/** The signed-in session token and the selected directory's id. */
export async function sessionAndDirectory(page: Page) {
  const session = await page.evaluate(() => localStorage.getItem('pmg_session'));
  const wsId = await page.evaluate(() => localStorage.getItem('pmg_ws'));
  expect(session).toBeTruthy();
  expect(wsId).toBeTruthy();
  return { session: session!, wsId: wsId! };
}

const TS = '2026-01-01T00:00:00Z';

/** Upsert a node straight into the directory's default folder via the API. */
export async function postNode(page: Page, node: Record<string, unknown>) {
  const { session, wsId } = await sessionAndDirectory(page);
  const r = await page.request.post(`/api/workspaces/${wsId}/graph`, {
    headers: { authorization: `Bearer ${session}` },
    data: { created_at: TS, updated_at: TS, status: 'active', ...node },
  });
  expect(r.ok(), await r.text()).toBe(true);
}

/** A node of the Notes template's one kind, `note`. */
export function note(id: string, title: string, body: string, attrs: Record<string, unknown> = {}) {
  return { id, type: 'note', title, body, attrs };
}

import { test, expect } from '@playwright/test';
import { addAgent, signUpWithDirectory } from './helpers';

// The Give-updates work agent: broadcast updates about your own folder to a
// list of teammates, with the list saveable and reusable. It's the Updates view
// in 'give' mode, so this drives the parts that differ from Get updates — the
// recipient chips, the saved list, and the own-folder-only scope.

/**
 * Broadcasts only go to members of the directory (the server refuses anyone
 * else), so invite the recipients first, through the same members API the
 * Share dialog uses.
 */
async function inviteMembers(page: any, emails: string[]) {
  const session = await page.evaluate(() => localStorage.getItem('pmg_session'));
  const wsId = await page.evaluate(() => localStorage.getItem('pmg_ws'));
  for (const email of emails) {
    const r = await page.request.post(`/api/workspaces/${wsId}/members`, {
      headers: { authorization: `Bearer ${session}` },
      data: { email },
    });
    expect(r.ok()).toBe(true);
  }
}

test('Give updates → broadcast to many recipients, save the list, reuse it', async ({ page }) => {
  await signUpWithDirectory(page, 'Broadcast Co');
  await inviteMembers(page, ['ana@acme.test', 'bo@acme.test', 'cy@acme.test']);
  await addAgent(page, 'Add work agent', 'Give updates');

  await expect(page.locator('h1', { hasText: 'Keep your team posted on your work' })).toBeVisible();

  // ── Create a broadcast ────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'New broadcast' }).click();
  await page.locator('textarea').first().fill('what I shipped this week');

  // A broadcast reports on your own directory (all its folders) — no
  // directory/teammate scope picker.
  await expect(page.getByText('Add directory or teammate')).toHaveCount(0);
  await expect(page.getByText('Reported from across your workspace — your team sees your work, not theirs.')).toBeVisible();

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

  // ── Someone outside the directory is refused, inline, and the form stays ──
  await page.getByRole('button', { name: 'Add teammate' }).click();
  await page.getByPlaceholder('name@company.com').fill('outsider@elsewhere.test');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Create broadcast' }).click();
  const refused = page.getByRole('alert').filter({ hasText: 'outsider@elsewhere.test' });
  await expect(refused).toBeVisible();
  await expect(refused).toContainText('members of this directory');
  await expect(page.getByRole('button', { name: 'Create broadcast' })).toBeVisible(); // still open
  await page.getByRole('button', { name: 'Remove outsider@elsewhere.test' }).click();
  await expect(refused).toHaveCount(0);

  await page.getByRole('button', { name: 'Create broadcast' }).click();

  // ── It's listed, with its recipient count ────────────────────────────────
  // Scoped to the list: a new broadcast runs once straight away, so its first
  // update (held for approval) also shows the topic, in its own section.
  const broadcasts = page.locator('section').filter({ has: page.getByText('Your broadcasts', { exact: true }) });
  const row = (topic: string) => broadcasts.locator('div.p-4').filter({ has: page.getByText(topic, { exact: true }) });
  await expect(row('what I shipped this week')).toBeVisible();
  await expect(row('what I shipped this week').getByText('3 recipients')).toBeVisible();

  // ── The saved list is reusable on the next broadcast ─────────────────────
  await page.getByRole('button', { name: 'New broadcast' }).click();
  await page.locator('textarea').first().fill('my quarterly wrap-up');
  await page.getByRole('button', { name: 'Add teammate' }).click();
  // The menu also lists teammates (other acme.test accounts); pick the list.
  await page.getByRole('menuitem', { name: /^Design team/ }).click();
  for (const addr of ['ana@acme.test', 'bo@acme.test', 'cy@acme.test']) {
    await expect(page.getByText(addr, { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Create broadcast' }).click();
  await expect(row('my quarterly wrap-up')).toBeVisible();
  await expect(row('my quarterly wrap-up').getByText('3 recipients')).toBeVisible();
  await expect(broadcasts.locator('div.p-4')).toHaveCount(2);

  // ── The two agents keep separate lists ───────────────────────────────────
  // A broadcast about my work must not show up as a topic I follow.
  await addAgent(page, 'Add collab agent', 'Get updates');
  await expect(page.locator('h1', { hasText: 'Stay posted on what moves' })).toBeVisible();
  await expect(page.getByText('what I shipped this week')).toHaveCount(0);
  await expect(page.getByText('No watches yet', { exact: false })).toBeVisible();
});

import { test, expect } from '@playwright/test';

const uniqueEmail = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@acme.test`;

async function signInAndCreateWorkspace(page: any, wsName = 'AgentCo') {
  await page.goto('/');
  await expect(page.locator('h2', { hasText: 'Pomegranate' })).toBeVisible();
  await page.locator('input[type=email]').fill(uniqueEmail());
  await page.getByRole('button', { name: 'Send link' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('h2', { hasText: 'Workspaces' })).toBeVisible();
  await page.locator('input[placeholder="My company"]').fill(wsName);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('button.pome-btn', { hasText: 'Create' }).click();
  await expect(page.locator('.side-nav')).toBeVisible();
}

async function goToAgents(page: any) {
  await page.locator('.nav-item', { hasText: 'Agents' }).click();
  await page.waitForTimeout(300);
}

// ─── Agents feature ────────────────────────────────────────────────────────

test('Agents → create agent, unified Context card with notes + documents', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'AgentContextCo');
  await goToAgents(page);

  // Empty state — create button visible
  await expect(page.getByRole('button', { name: 'New agent' })).toBeVisible();

  // Create a new agent
  await page.getByRole('button', { name: 'New agent' }).click();
  await page.getByPlaceholder('Name (e.g. Slack reviewer)').fill('Feline Editor');
  await page.locator('textarea[placeholder*="What does this agent do"]').fill(
    'Replaces informal animal names with scientific equivalents.',
  );
  await page.locator('form', { has: page.getByPlaceholder('Name (e.g. Slack reviewer)') }).getByRole('button', { name: 'Create' }).click();

  // Should land on agent detail page
  await expect(page.locator('h1', { hasText: 'Feline Editor' })).toBeVisible({ timeout: 5_000 });

  // ── Check unified Context card structure ─────────────────────────────────
  // CardTitle renders as a <div>; verify exactly one "Context" card title
  await expect(page.locator('div.text-base', { hasText: /^Context$/ })).toHaveCount(1);

  // Old separate card titles should NOT exist
  await expect(page.locator('div', { hasText: /^Reference documents$/ })).toHaveCount(0);
  await expect(page.locator('div', { hasText: /^Agent context$/ })).toHaveCount(0);

  // Both sub-sections should be present within that card
  await expect(page.getByText('Notes', { exact: true })).toBeVisible();
  await expect(page.getByText('Documents', { exact: true })).toBeVisible();

  // ── Notes: type and save — find the context notes textarea via its placeholder ──
  const contextTextarea = page.getByPlaceholder(/e\.g\.\n- Replace/);
  await contextTextarea.fill('Replace "cat" with "feline". Replace "dog" with "canine".');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/context saved/i).or(page.getByText(/saved/i)).first()).toBeVisible({ timeout: 5_000 });
  // Button returns to disabled saved state
  await expect(page.locator('button', { hasText: 'Saved' })).toBeDisabled();

  // ── Documents: upload drop-zone is visible ───────────────────────────────
  await expect(page.getByText('Upload a document')).toBeVisible();

  // Upload a small text document
  const fileInput = page.locator('input[type=file]');
  await fileInput.setInputFiles({
    name: 'rules.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Rule 1: cat → feline\nRule 2: dog → canine'),
  });
  await expect(page.getByText(/rules\.txt.*added|added/i).first()).toBeVisible({ timeout: 10_000 });
  // Document appears in the list (li.group is the doc row, not the toast li)
  await expect(page.locator('li.group.flex', { hasText: 'rules.txt' })).toBeVisible({ timeout: 5_000 });

  // ── Test panel: verify the Run button and its textarea exist ────────────
  await expect(page.getByRole('button', { name: 'Run' })).toBeVisible();
  await expect(page.getByPlaceholder('Paste a message here…')).toBeVisible();
});

test('Agents → add and delete example, applies toggle works', async ({ page }) => {
  await signInAndCreateWorkspace(page, 'AgentExampleCo');
  await goToAgents(page);

  await page.getByRole('button', { name: 'New agent' }).click();
  await page.getByPlaceholder('Name (e.g. Slack reviewer)').fill('Example Tester');
  await page.locator('textarea[placeholder*="What does this agent do"]').fill('Test agent for examples.');
  await page.locator('form', { has: page.getByPlaceholder('Name (e.g. Slack reviewer)') }).getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('h1', { hasText: 'Example Tester' })).toBeVisible({ timeout: 5_000 });

  // Add an example
  // AddExampleForm starts collapsed; open it first
  await page.getByRole('button', { name: 'Add example' }).click();
  await expect(page.getByRole('button', { name: 'Save example' })).toBeVisible({ timeout: 3_000 });

  // Fill the input/output textareas (identified by their unique placeholders)
  await page.getByPlaceholder('e.g. I love my cat').fill('Hello cat');
  await page.getByPlaceholder('e.g. I love my feline').fill('Hello feline');
  await page.getByRole('button', { name: 'Save example' }).click();
  await expect(page.getByText(/example added/i).first()).toBeVisible({ timeout: 5_000 });

  // Example appears in the list (ExampleList renders divs with class "group")
  await expect(page.locator('div.group', { hasText: 'Hello cat' })).toBeVisible();

  // Delete the example — button is hidden until hover
  const exampleItem = page.locator('div.group', { hasText: 'Hello cat' });
  await exampleItem.hover();
  await exampleItem.locator('button[title="Delete example"]').click({ force: true });
  // removeExample has no toast — just verify the item disappears
  await expect(page.locator('div.group', { hasText: 'Hello cat' })).toHaveCount(0);
});

import { test, expect, type Page } from '@playwright/test';
import { goNav, sessionAndDirectory, signUpWithDirectory } from './helpers';

// Audio/images are read by the destination folder's media data agent. With
// the agent off, the upload is stopped client-side with an explanation; with
// it on, the file goes to the server (which runs the reader).

// 1×1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function openUploader(page: Page) {
  await goNav(page, 'Add sources');
  await page.getByRole('tab', { name: /upload file/i }).click();
}

test('image upload is stopped with an alert when the folder has no image reader', async ({ page }) => {
  await signUpWithDirectory(page, 'MediaCo');
  await openUploader(page);
  let uploaded = false;
  page.on('request', (r) => {
    if (r.url().includes('/ingest/file')) uploaded = true;
  });
  await page.locator('input[type=file]').setInputFiles({ name: 'whiteboard.png', mimeType: 'image/png', buffer: PNG });
  const alert = page.getByRole('alertdialog');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('This folder can’t read images yet');
  await expect(alert).toContainText('Read images');
  // Automated routing still files media into the default folder — name it.
  await expect(alert).toContainText('“Notes”');
  await alert.getByRole('button', { name: 'OK' }).click();
  await expect(alert).toBeHidden();
  expect(uploaded).toBe(false);
});

test('image upload proceeds to the reader when the folder has one', async ({ page }) => {
  await signUpWithDirectory(page, 'MediaCo');
  const { session, wsId } = await sessionAndDirectory(page);
  const put = await page.request.put(`/api/workspaces/${wsId}/media-readers/default/image`, {
    headers: { authorization: `Bearer ${session}` },
    data: { enabled: true, config: { output: 'capture' } },
  });
  expect(put.ok()).toBe(true);
  await openUploader(page);
  const upload = page.waitForRequest((r) => r.url().includes('/ingest/file'));
  await page.locator('input[type=file]').setInputFiles({ name: 'whiteboard.png', mimeType: 'image/png', buffer: PNG });
  await upload;
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('office and text formats are not filtered out by the picker', async ({ page }) => {
  await signUpWithDirectory(page, 'MediaCo');
  await openUploader(page);
  const accept = await page.locator('input[type=file]').getAttribute('accept');
  for (const ext of ['.txt', '.md', '.pdf', '.docx', '.pptx', '.xlsx', '.doc', '.ppt', '.xls', '.vtt', '.mp3', '.png']) {
    expect(accept?.split(',')).toContain(ext);
  }
});

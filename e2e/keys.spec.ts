import { expect, test, type Page } from '@playwright/test';

const unique = (label: string) => `${label} ${Date.now().toString(36)}`;
const row = (page: Page, name: string) => page.getByTestId('key-row').filter({ hasText: name });

async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('live-indicator')).toHaveAttribute('data-connection', 'live');
}

async function createKey(page: Page, name: string) {
  await page.getByRole('button', { name: '+ Create key' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
}

test('create: secret is shown once, with a warning, and the key goes active live', async ({ page }) => {
  const name = unique('Prod backend');
  await open(page);
  await createKey(page, name);

  const banner = page.getByRole('status', { name: 'New key secret' });
  await expect(banner).toContainText('It won’t be shown again');
  await expect(banner).toContainText('won’t work yet');
  const secret = await page.getByTestId('secret').innerText();
  expect(secret).toMatch(/^csk_live_[0-9A-Za-z]{40}$/);

  // Per-system status while provisioning: state, attempt, elapsed.
  const keyRow = row(page, name);
  await expect(keyRow.getByTestId('key-status')).toHaveText('provisioning');
  await expect(keyRow.getByTestId('system-gateway')).toContainText(/attempt \d+ · \d+:\d\d/);
  await expect(keyRow.getByTestId('system-metering')).toBeVisible();

  // No reload: the stream moves it to active.
  await expect(keyRow.getByTestId('key-status')).toHaveText('active', { timeout: 90_000 });

  // Survives reload, and the secret does not.
  await page.reload();
  await expect(row(page, name).getByTestId('key-status')).toHaveText('active');
  await expect(page.getByTestId('secret')).toHaveCount(0);
  expect(await page.content()).not.toContain(secret);
});

test('another admin sees creates and revokes within 2 seconds', async ({ browser }) => {
  const name = unique('Shared');
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await open(alice);
  await open(bob);

  await createKey(alice, name);
  await expect(row(bob, name)).toBeVisible({ timeout: 2_000 });

  await alice.getByRole('button', { name: 'I’ve saved it' }).click();
  await row(alice, name).getByRole('button', { name: /Revoke/ }).click();
  const dialog = alice.getByRole('dialog');
  await expect(dialog).toContainText('may still be accepted until the gateway confirms');
  await dialog.getByRole('button', { name: 'Revoke key' }).click();

  await expect(row(bob, name).getByTestId('key-status')).toHaveText('revoking', { timeout: 2_000 });
  await expect(row(bob, name).getByTestId('revoke-warning')).toContainText('May still be accepted until the gateway confirms');
  await expect(row(bob, name).getByTestId('key-status')).toHaveText('revoked', { timeout: 120_000 });
  await expect(row(alice, name).getByTestId('key-status')).toHaveText('revoked');
});

test('members get a read-only page and the server rejects their writes', async ({ page }) => {
  await open(page);
  await page.getByLabel('Dev role').selectOption('member');

  await expect(page.getByText('Members see this page read-only')).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Create key' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Revoke/ })).toHaveCount(0);
  await expect(page.getByTestId('key-row').first()).toBeVisible();

  // Same cookie the page uses, straight at the API.
  const res = await page.request.post('/api/v1/keys', { data: { name: 'sneaky' } });
  expect(res.status()).toBe(403);
});

import { test, expect } from '@playwright/test';

test('mock injected wallet connects read-only and stays disconnected across refresh polling', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as Window & { __walletMethods?: string[]; ethereum?: unknown };
    state.__walletMethods = [];
    state.ethereum = { request: async ({ method }: { method: string }) => {
      state.__walletMethods!.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x1111111111111111111111111111111111111111'];
      if (method === 'eth_chainId') return '0xa869';
      throw new Error('Unexpected signing or network request: ' + method);
    }, on() {}, removeListener() {} };
  });
  await page.goto('/markets');
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).first().click();
  await expect(page.getByText('Approvals, transactions and signing remain disabled.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
  await expect(page.getByTitle('Click to disconnect')).toBeVisible();
  const methods = await page.evaluate(() => (window as Window & { __walletMethods?: string[] }).__walletMethods ?? []);
  expect(methods).toContain('eth_requestAccounts');
  expect(methods.every(method => ['eth_requestAccounts', 'eth_accounts', 'eth_chainId'].includes(method))).toBe(true);
  await page.getByTitle('Click to disconnect').click();
  await expect(page.getByRole('button', { name: 'Connect Wallet', exact: true }).first()).toBeVisible();
  await page.waitForTimeout(3200);
  await expect(page.getByRole('button', { name: 'Connect Wallet', exact: true }).first()).toBeVisible();
});

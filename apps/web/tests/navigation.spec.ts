import { test, expect } from '@playwright/test';

for (const alreadyRemoved of [false, true]) {
  test(`client navigation survives chart teardown (vendor DOM already removed: ${alreadyRemoved})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && message.text().includes('parentNode')) errors.push(message.text()); });
    await page.route('https://s3.tradingview.com/tv.js', route => route.fulfill({ contentType: 'application/javascript', body: `
      window.TradingView = {widget: class {
        constructor(config) {
          this.id = config.container_id;
          window.__chartCreations = (window.__chartCreations || 0) + 1;
          ${alreadyRemoved ? 'setTimeout(() => document.getElementById(this.id)?.remove(), 0);' : ''}
        }
        remove() {
          const node = document.getElementById(this.id);
          node.parentNode.removeChild(node);
        }
      }};
    ` }));
    await page.goto('/');
    await page.locator('.agent-launch').click();
    await expect(page).toHaveURL(/\/trade\/AVAX-PERP$/);
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.waitForFunction(expected => ((window as Window & { __chartCreations?: number }).__chartCreations ?? 0) >= expected, cycle + 1);
      await page.getByRole('link', { name: 'Markets', exact: true }).click();
      await expect(page).toHaveURL(/\/markets$/);
      await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0);
      await page.getByRole('link', { name: 'Portfolio', exact: true }).click();
      await expect(page).toHaveURL(/\/portfolio$/);
      await page.getByRole('link', { name: 'Trade', exact: true }).click();
      await expect(page).toHaveURL(/\/trade\/AVAX-PERP$/);
    }
    await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173', browserName: 'chromium', viewport: { width: 1440, height: 1000 } },
  webServer: { command: 'npm run start -- --hostname 127.0.0.1 --port 4173', url: 'http://127.0.0.1:4173', timeout: 30000 },
});

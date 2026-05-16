import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 10000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 5000,
  },
  webServer: {
    command: 'node server.js',
    port: 3000,
    timeout: 5000,
    reuseExistingServer: !process.env.CI,
  },
});

import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 3123);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 5000,
    permissions: ['microphone', 'camera'],
    launchOptions: {
      // Optional: point at a preinstalled Chromium (e.g. CI images)
      ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: {
    command: 'node server.js',
    url: `http://127.0.0.1:${PORT}/health`,
    timeout: 10000,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      // Tests open many sockets from one IP; keep host limits out of the way.
      MAX_CONNECTIONS_PER_IP: '200',
      MAX_SERVERS_PER_IP: '200',
      CONNECT_RATE_PER_IP: '1000',
      // No public STUN in tests: host candidates are enough on one machine.
      STUN_URLS: '',
      DISCONNECT_GRACE_MS: '5000',
    },
  },
});

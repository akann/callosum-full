import { defineConfig, devices } from '@playwright/test';

// Runs against the real stack (`pnpm dev`: Postgres, both mocks, API, worker, web).
// When Playwright starts the stack itself the mocks run 10x faster than the spec timings;
// against an already running `pnpm dev` they run at whatever TIME_SCALE that was started with.
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  // PW_CHANNEL=chrome uses the installed Google Chrome (fresh temporary profile) instead of Playwright's own Chromium.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173/api/v1/me',
    // /me answers 401 without a session, which is all we need to know the API is up behind the proxy.
    ignoreHTTPSErrors: true,
    reuseExistingServer: true,
    timeout: 60_000,
    env: { TIME_SCALE: '10' },
  },
});

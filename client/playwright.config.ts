import { defineConfig } from '@playwright/test';

/**
 * End-to-end smoke tests run against the production build (the same files GitHub Pages serves).
 * Locally set PW_CHANNEL=msedge (or chrome) to use an installed browser instead of downloading one.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1, // software-rendered browsers starve each other when run in parallel
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173/marble-game/',
    channel: process.env.PW_CHANNEL || undefined,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
    },
  },
  webServer: [
    {
      command: 'npm run build && npx vite preview --port 4173 --strictPort',
      url: 'http://localhost:4173/marble-game/',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    // The multiplayer tests need the Python server (set NET_E2E=1; requires `uv` and `cd server && uv sync`).
    ...(process.env.NET_E2E
      ? [
          {
            command: 'uv run uvicorn app.main:app --host 127.0.0.1 --port 8000',
            cwd: '../server',
            url: 'http://127.0.0.1:8000/health',
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
        ]
      : []),
  ],
});

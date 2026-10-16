import { defineConfig } from '@playwright/test';

/**
 * End-to-end smoke tests run against the production build (the same files GitHub Pages serves).
 * Locally set PW_CHANNEL=msedge (or chrome) to use an installed browser instead of downloading one.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173/marble-game/',
    channel: process.env.PW_CHANNEL || undefined,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
    },
  },
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/marble-game/',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});

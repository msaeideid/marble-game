import { defineConfig } from 'vite';

// GitHub Pages serves the project at /marble-game/, so production builds need that base.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/marble-game/' : '/',
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  test: { include: ['tests/**/*.test.ts'] },
}));

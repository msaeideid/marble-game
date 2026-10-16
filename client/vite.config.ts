import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// GitHub Pages serves the project at /marble-game/, so production builds need that base.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/marble-game/' : '/',
  resolve: { alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) } },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  server: { fs: { allow: ['..'] } },
  test: { include: ['tests/**/*.test.ts'] },
}));

import { defineConfig } from 'vitest/config';

/** GitHub Pages serves this project from https://mustafaobaidd1.github.io/scatter-sky-lab/ */
export const REPO = 'scatter-sky-lab';

export default defineConfig({
  // Same base path in dev, preview and production, so path bugs show up locally.
  base: `/${REPO}/`,
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: { port: 5302, strictPort: true },
  preview: { port: 5402, strictPort: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});

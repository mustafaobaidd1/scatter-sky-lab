import { defineConfig } from 'vitest/config';

/** `npm run validate`: slower validation runs that record their numbers for the README. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['validation/**/*.validate.ts'],
    testTimeout: 600_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'], // Only run source test files, not compiled dist
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'dist/**',
        'test/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/test-fixtures/**',
      ],
    },
  },
});

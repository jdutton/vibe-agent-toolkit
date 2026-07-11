import { defineConfig } from 'vitest/config';

import { createIntegrationTestConfig } from './vitest.shared.js';

export default defineConfig({
  test: {
    ...createIntegrationTestConfig(),
    // Monorepo-wide include (not package-relative) — this file backs the uncached,
    // full-repo `test:integration` path used only via vitest.setup.js consumers
    // outside the turbo-cached scripts (e.g. ad hoc full-repo runs).
    include: [
      'packages/*/test/**/*.integration.test.ts',
      'packages/*/src/**/*.integration.test.ts',
    ],
  },
});

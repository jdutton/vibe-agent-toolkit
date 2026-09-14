import { defineConfig } from 'vitest/config';

import { createIntegrationTestConfig, rootSerialReporters } from './vitest.shared.js';

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
    // One file at a time, by construction: this config is the per-file duration
    // ratchet's judge, and a duration is only a measurement when nothing else is
    // running — see `rootSerialReporters` in vitest.shared.ts.
    fileParallelism: false,
    reporters: rootSerialReporters(['default']),
  },
});

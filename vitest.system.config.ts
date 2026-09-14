import { defineConfig } from 'vitest/config';

import { createSystemTestConfig, rootSerialReporters, windowsExcludedCliSystemTests } from './vitest.shared.js';

export default defineConfig({
  test: {
    ...createSystemTestConfig({
      // One list with packages/cli/vitest.system.config.ts — see vitest.shared.ts.
      exclude: windowsExcludedCliSystemTests('packages/cli/'),
    }),
    // Monorepo-wide include (not package-relative) — this file backs `test:watch`,
    // `validate-links`, and other uncached full-repo commands; see vitest-test-caching-design.
    include: [
      'packages/*/test/**/*.system.test.ts',
      'packages/*/src/**/*.system.test.ts',
    ],
    // One serial process: ceilings only — see `rootSerialReporters`.
    reporters: rootSerialReporters([['default', { summary: false }]]),
  },
});

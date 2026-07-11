import { defineConfig } from 'vitest/config';

import { createSystemTestConfig } from './vitest.shared.js';

export default defineConfig({
  test: {
    ...createSystemTestConfig({
      // Windows: Skip tests that require symlinks (elevated privileges), bun wrapper
      // (null exit status), MCP package resolution, or full-project scans (10-20x slower).
      // skills-list-fixture.system.test.ts and skills-validate-fixture.system.test.ts provide Windows coverage
      exclude:
        process.platform === 'win32'
          ? [
              'packages/cli/test/system/bin-wrapper.system.test.ts',
              'packages/cli/test/system/mcp-stdio-protocol.system.test.ts',
              'packages/cli/test/system/skills-install-dev.system.test.ts',
              'packages/cli/test/system/skills-list.system.test.ts',
              'packages/cli/test/system/skills-uninstall.system.test.ts',
              'packages/cli/test/system/skills-validate.system.test.ts',
            ]
          : [],
    }),
    // Monorepo-wide include (not package-relative) — this file backs `test:watch`,
    // `validate-links`, and other uncached full-repo commands; see vitest-test-caching-design.
    include: [
      'packages/*/test/**/*.system.test.ts',
      'packages/*/src/**/*.system.test.ts',
    ],
  },
});

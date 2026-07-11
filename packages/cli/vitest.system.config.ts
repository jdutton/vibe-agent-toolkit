import { defineConfig } from 'vitest/config';

import { createSystemTestConfig } from '../../vitest.shared.js';

export default defineConfig({
  test: createSystemTestConfig({
    // Windows: Skip tests that require symlinks (elevated privileges), bun wrapper
    // (null exit status), MCP package resolution, or full-project scans (10-20x slower).
    // skills-list-fixture / skills-validate-fixture system tests provide Windows coverage instead.
    exclude:
      process.platform === 'win32'
        ? [
            'test/system/bin-wrapper.system.test.ts',
            'test/system/mcp-stdio-protocol.system.test.ts',
            'test/system/skills-install-dev.system.test.ts',
            'test/system/skills-list.system.test.ts',
            'test/system/skills-uninstall.system.test.ts',
            'test/system/skills-validate.system.test.ts',
          ]
        : [],
  }),
});

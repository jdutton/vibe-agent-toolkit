import { defineConfig } from 'vitest/config';

import { createSystemTestConfig, windowsExcludedCliSystemTests } from '../../vitest.shared.js';

export default defineConfig({
  test: createSystemTestConfig({
    // One list with the root vitest.system.config.ts — see vitest.shared.ts.
    exclude: windowsExcludedCliSystemTests(),
  }),
});

import { defineConfig } from 'vitest/config';

import { createUnitTestConfig } from '../../vitest.shared.js';

export default defineConfig({
  test: createUnitTestConfig({
    // The entry points only; `src/commands/**` is unit-tested (79 unit files
    // reach 73 of its modules) and is counted — see the root vitest.config.ts.
    coverageExclude: ['src/bin.ts', 'src/bin/**'],
  }),
});

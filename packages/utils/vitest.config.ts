import { defineConfig } from 'vitest/config';

import { createUnitTestConfig } from '../../vitest.shared.js';

export default defineConfig({
  test: createUnitTestConfig({
    coverageExclude: [
      'src/fs.ts',
      'src/process.ts',
    ],
  }),
});

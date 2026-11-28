import { defineConfig } from 'vitest/config';

import { createUnitTestConfig } from '../../vitest.shared.js';

export default defineConfig({
  test: {
    ...createUnitTestConfig({
      coverageExclude: [
        '**/test-fixtures/**',
      ],
    }),
    // The vendored TypeScript is a 9 MB prebuilt CommonJS file. Left to vite-node it is transformed
    // on every test file that loads it (about 1 s idle, over the 10 s hook budget on a loaded CI
    // runner); externalized, Node's own loader reads it (about 60 ms), exactly as the shipped build does.
    server: { deps: { external: [/\/vendor\/typescript\.cjs$/] } },
  },
});

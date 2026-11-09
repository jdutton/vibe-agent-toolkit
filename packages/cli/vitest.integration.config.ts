import { defineConfig } from 'vitest/config';

import { cliIntegrationTestWorkers, createIntegrationTestConfig } from '../../vitest.shared.js';

export default defineConfig({
  test: createIntegrationTestConfig({ maxWorkers: cliIntegrationTestWorkers }),
});

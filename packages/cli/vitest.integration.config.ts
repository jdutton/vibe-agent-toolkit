import { defineConfig } from 'vitest/config';

import { createIntegrationTestConfig } from '../../vitest.shared.js';

export default defineConfig({
  test: createIntegrationTestConfig(),
});

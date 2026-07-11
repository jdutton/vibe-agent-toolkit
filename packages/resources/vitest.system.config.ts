import { defineConfig } from 'vitest/config';

import { createSystemTestConfig } from '../../vitest.shared.js';

export default defineConfig({
  test: createSystemTestConfig(),
});

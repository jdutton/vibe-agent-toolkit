import { it } from 'vitest';

import { runTestEnvCheck, TEST_ENV_GUARANTEE } from '../test-env-guarantee.js';

it.each(TEST_ENV_GUARANTEE)('the test-environment guarantee, in the integration lane: %s', runTestEnvCheck);

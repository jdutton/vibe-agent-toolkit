/**
 * The exit-code matrix, shard `audit`: `vat audit`, `audit settings`, `inventory`, `corpus scan`, `okf validate` and `ard emit`.
 *
 * The scenarios are not here. This file runs the slice of the ONE table that
 * `MATRIX_SHARDS` assigns to the shard it is NAMED after — see
 * `test-helpers/exit-code-matrix.ts`, and `exit-code-matrix.system.test.ts` for
 * what keeps the shards a partition of the table.
 */

import { describe, it } from 'vitest';

import {
  exitCodeMatrixShard,
  expectScenarioEndsOnItsDerivedCode,
  MATRIX_SCENARIO_TIMEOUT_MS,
  useMatrixTempDir,
} from './test-helpers/exit-code-matrix.js';

describe('exit codes are derived from the published document — shard audit (system test)', () => {
  useMatrixTempDir();

  // The assertions are in `expectScenarioEndsOnItsDerivedCode`: status, refusal code, gate, derived exit code.
  it.for(exitCodeMatrixShard(import.meta.url))(
    '$verb → $status ends on the code its document derives',
    { timeout: MATRIX_SCENARIO_TIMEOUT_MS },
    expectScenarioEndsOnItsDerivedCode,
  );
});

/**
 * The exit-code matrix, shard `audit`: `vat audit`, `audit settings`, `inventory`, `corpus scan`, `okf validate` and `ard emit`.
 *
 * The scenarios are not here. This file runs the slice of the ONE table that
 * `MATRIX_SHARDS` assigns to the shard it is NAMED after — see
 * `test-helpers/exit-code-matrix.ts`, and `exit-code-matrix.system.test.ts` for
 * what keeps the shards a partition of the table.
 */

import { describe, expect, it } from 'vitest';

import {
  exitCodeTheContractGives,
  expectScenarioEndsOnItsDerivedCode,
  MATRIX_SCENARIO_TIMEOUT_MS,
  useExitCodeMatrixShard,
} from './test-helpers/exit-code-matrix.js';

// `expectScenarioEndsOnItsDerivedCode` asserts status, refusal code, gate and derived exit code; the call
// site checks the exit code against the contract's literal rules over the findings list, independent of the derivation.
describe('exit codes are derived from the published document — shard audit (system test)', () => {
  it.for(useExitCodeMatrixShard(import.meta.url))(
    '$verb → $status ends on the code its document derives (audit)',
    { timeout: MATRIX_SCENARIO_TIMEOUT_MS },
    (scenario, context) => {
      const run = expectScenarioEndsOnItsDerivedCode(scenario, context);
      expect(run.exitCode).toBe(exitCodeTheContractGives(run.document));
    },
  );
});

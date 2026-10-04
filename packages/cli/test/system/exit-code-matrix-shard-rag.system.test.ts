/**
 * The exit-code matrix, shard `rag`: the `vat rag` verbs.
 *
 * The scenarios are not here. This file runs the slice of the ONE table that
 * `MATRIX_SHARDS` assigns to the shard it is NAMED after — see
 * `test-helpers/exit-code-matrix.ts`, and `exit-code-matrix.system.test.ts` for
 * what keeps the shards a partition of the table.
 */

import { exitCodeForReport } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import {
  expectScenarioEndsOnItsDerivedCode,
  MATRIX_SCENARIO_TIMEOUT_MS,
  useExitCodeMatrixShard,
} from './test-helpers/exit-code-matrix.js';

// `expectScenarioEndsOnItsDerivedCode` asserts status, refusal code, gate and derived exit code, and
// returns what it read, so the call site re-asserts the derivation (docs/writing-tests.md).
describe('exit codes are derived from the published document — shard rag (system test)', () => {
  it.for(useExitCodeMatrixShard(import.meta.url))(
    '$verb → $status ends on the code its document derives (rag)',
    { timeout: MATRIX_SCENARIO_TIMEOUT_MS },
    (scenario, context) => {
      const run = expectScenarioEndsOnItsDerivedCode(scenario, context);
      expect(run.exitCode).toBe(exitCodeForReport(run.document));
    },
  );
});

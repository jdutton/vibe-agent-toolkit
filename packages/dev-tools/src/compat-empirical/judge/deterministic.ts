/**
 * Deterministic, zero-LLM classifier.
 *
 * Maps a RuntimeObservation to a DeterministicClass using only the
 * structural facts the harness recorded — exit status, invocation
 * detection, and whether the output text was non-empty.
 */

import type { DeterministicClass, RuntimeObservation } from '../types.js';

export function classifyDeterministic(obs: RuntimeObservation): DeterministicClass {
  if (obs.exitStatus === 'skipped' || obs.exitStatus === 'user-aborted') {
    return 'skipped';
  }
  if (obs.exitStatus === 'timeout') {
    return 'timeout';
  }
  if (obs.exitStatus === 'error') {
    // TASK-5-WILL-REPLACE: temporary mapping — Task 5 splits this into
    // install-failed vs runtime-error and adds the refused-detection regex.
    return obs.installResult.ok ? 'runtime-error' : 'install-failed';
  }
  if (!obs.invocationDetected) {
    // TASK-5-WILL-REPLACE: temporary mapping — Task 5 distinguishes
    // not-invoked-engaged (output present) from not-invoked-empty.
    return obs.outputText.trim().length > 0 ? 'not-invoked-engaged' : 'not-invoked-empty';
  }
  return obs.outputText.trim().length > 0 ? 'invoked-output' : 'invoked-no-output';
}

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
    return 'error';
  }
  if (!obs.invocationDetected) {
    return 'not-invoked';
  }
  return obs.outputText.trim().length > 0 ? 'invoked-output' : 'invoked-no-output';
}

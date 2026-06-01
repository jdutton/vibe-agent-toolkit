/**
 * Deterministic, zero-LLM classifier.
 *
 * Maps a RuntimeObservation to a DeterministicClass using only the
 * structural facts the harness recorded — exit status, invocation
 * detection, transcript text, and install result.
 *
 * Refusal detection is best-effort via a small regex over common refusal
 * templates; the LLM judge corroborates or contradicts. Task 5 may extend
 * this set after the first corpus run produces refusal examples.
 */

import type { DeterministicClass, RuntimeObservation } from '../types.js';

const REFUSAL_PATTERNS: readonly RegExp[] = [
  /\bI(?:'m| am) not able to\b/i,
  /\bI cannot\b/i,
  /\bI(?:'m| am) unable to\b/i,
  /\bI will not\b/i,
  /\bI(?:'m| am) sorry, but I (?:can'?t|won'?t)\b/i,
];

function matchesRefusal(text: string): boolean {
  return REFUSAL_PATTERNS.some((re) => re.test(text));
}

export function classifyDeterministic(obs: RuntimeObservation): DeterministicClass {
  if (obs.exitStatus === 'skipped' || obs.exitStatus === 'user-aborted') {
    return 'skipped';
  }
  if (obs.exitStatus === 'timeout') {
    return 'timeout';
  }

  // install-failed takes precedence over runtime-error: an unsuccessful install
  // is always classified as install-failed regardless of how the runtime exited.
  if (!obs.installResult.ok) {
    return 'install-failed';
  }
  if (obs.exitStatus === 'error') {
    return 'runtime-error';
  }

  if (!obs.invocationDetected) {
    if (matchesRefusal(obs.outputText)) return 'refused';
    return obs.outputText.trim().length > 0 ? 'not-invoked-engaged' : 'not-invoked-empty';
  }
  // Invocation detected. Refusal still possible if the agent triggered then refused.
  if (matchesRefusal(obs.outputText)) return 'refused';
  return obs.outputText.trim().length > 0 ? 'invoked-output' : 'invoked-no-output';
}

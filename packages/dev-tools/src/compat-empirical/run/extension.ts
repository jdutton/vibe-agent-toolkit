/**
 * Adaptive extension criteria for repeatN=3 → 5.
 *
 * Pure function over the first 3 RuntimeObservations of a cell.
 * Uses ONLY deterministic signals so the extension decision fits in
 * the run phase without coupling to the judge phase. The four ambiguity
 * criteria are evaluated in order; the first match returns extend:true.
 *
 * Skip conditions short-circuit before any criterion:
 *   - repeatN !== 3 (operator opted out of adaptive extension explicitly)
 *   - cell has fewer than 3 observations (incomplete attempts)
 *   - any attempt was install-failed (installing failed; rerunning won't help)
 *   - all 3 attempts produced the identical deterministic class (unanimous)
 */

import { classifyDeterministic } from '../judge/deterministic.js';
import type { DeterministicClass, RuntimeObservation } from '../types.js';

export interface ExtensionDecision {
  extend: boolean;
  reason: string;
}

function isNotInvoked(c: DeterministicClass): boolean {
  return c === 'not-invoked-engaged' || c === 'not-invoked-empty';
}

function isTriggered(c: DeterministicClass): boolean {
  return c === 'invoked-output' || c === 'invoked-no-output';
}

function isTransient(c: DeterministicClass): boolean {
  return c === 'timeout' || c === 'runtime-error';
}

export function evaluateExtensionDecision(
  observations: readonly RuntimeObservation[],
  repeatN: number,
): ExtensionDecision {
  if (repeatN !== 3) return { extend: false, reason: 'repeatN-not-3' };
  if (observations.length !== 3) return { extend: false, reason: 'incomplete-attempts' };

  const classes = observations.map((o) => classifyDeterministic(o));

  if (classes.includes('install-failed')) {
    return { extend: false, reason: 'install-failed' };
  }
  if (classes.every((c) => c === classes[0])) {
    return { extend: false, reason: 'unanimous' };
  }

  // Criterion 1: mixed trigger outcomes (1 or 2 of 3 are not-invoked).
  const notInvokedCount = classes.filter(isNotInvoked).length;
  if (notInvokedCount === 1 || notInvokedCount === 2) {
    return { extend: true, reason: 'mixed trigger outcomes' };
  }

  // Criterion 2: mixed deterministic class among triggered attempts.
  const triggeredClasses = new Set(classes.filter(isTriggered));
  if (triggeredClasses.size > 1) {
    return { extend: true, reason: 'mixed deterministic class among triggered attempts' };
  }

  // Criterion 3: transient failure (timeout/runtime-error in 1 or 2, not all 3).
  const transientCount = classes.filter(isTransient).length;
  if (transientCount === 1 || transientCount === 2) {
    return { extend: true, reason: 'transient failure in some attempts' };
  }

  // Criterion 4: inconsistent refusal (1 or 2 refused, not all 3).
  const refusedCount = classes.filter((c) => c === 'refused').length;
  if (refusedCount === 1 || refusedCount === 2) {
    return { extend: true, reason: 'inconsistent refusal across attempts' };
  }

  return { extend: false, reason: 'no criterion fired' };
}

/**
 * Verdict engine — combines capability observations with declared targets
 * and runtime profiles to produce COMPAT_TARGET_* verdicts.
 *
 * Four states: expected (silent), incompatible (warning),
 * needs-review (warning), undeclared (info).
 */

import type { Observation } from '@vibe-agent-toolkit/agent-skills';

import { RUNTIME_PROFILES } from './runtime-profiles.js';
import type { Target } from './types.js';

export type VerdictCode =
  | 'COMPAT_TARGET_INCOMPATIBLE'
  | 'COMPAT_TARGET_NEEDS_REVIEW'
  | 'COMPAT_TARGET_UNDECLARED';

export interface Verdict {
  code: VerdictCode;
  observationCode: string;
  target: Target | undefined;
  summary: string;
}

function verdictForObservationAndTarget(
  observation: Observation,
  target: Target,
): Verdict[] {
  const profile = RUNTIME_PROFILES[target];

  switch (observation.code) {
    case 'CAPABILITY_LOCAL_SHELL':
      return profile.localShell === 'yes'
        ? []
        : [{
            code: 'COMPAT_TARGET_INCOMPATIBLE',
            observationCode: observation.code,
            target,
            summary: `Target '${target}' has no local shell but skill requires one.`,
          }];

    case 'CAPABILITY_BROWSER_AUTH':
      return profile.browser === 'yes'
        ? []
        : [{
            code: 'COMPAT_TARGET_INCOMPATIBLE',
            observationCode: observation.code,
            target,
            summary: `Target '${target}' has no browser but skill requires interactive browser auth.`,
          }];

    case 'CAPABILITY_EXTERNAL_CLI': {
      const binary = (observation.payload as { binary?: string } | undefined)?.binary;
      if (!binary) return [];
      if (profile.localShell === 'no') {
        return [{
          code: 'COMPAT_TARGET_INCOMPATIBLE',
          observationCode: observation.code,
          target,
          summary: `Target '${target}' has no local shell; external CLI '${binary}' cannot be invoked.`,
        }];
      }
      if (!profile.preinstalledBinaries.has(binary)) {
        return [{
          code: 'COMPAT_TARGET_NEEDS_REVIEW',
          observationCode: observation.code,
          target,
          summary: `Target '${target}' has shell but does not guarantee '${binary}' is installed.`,
        }];
      }
      return [];
    }

    default:
      return [];
  }
}

export interface VerdictInput {
  observations: Observation[];
  targets: Target[] | undefined;
}

export function computeVerdicts(input: VerdictInput): Verdict[] {
  if (input.targets === undefined) {
    const seen = new Set<string>();
    const out: Verdict[] = [];
    for (const obs of input.observations) {
      if (seen.has(obs.code)) continue;
      seen.add(obs.code);
      out.push({
        code: 'COMPAT_TARGET_UNDECLARED',
        observationCode: obs.code,
        target: undefined,
        summary: `Capability observation '${obs.code}' has no declared target.`,
      });
    }
    return out;
  }

  if (input.targets.length === 0) {
    return input.observations.map(obs => ({
      code: 'COMPAT_TARGET_INCOMPATIBLE' as const,
      observationCode: obs.code,
      target: undefined,
      summary: `Plugin declares "targets: []" (no runtime); observation '${obs.code}' is incompatible.`,
    }));
  }

  const verdicts: Verdict[] = [];
  for (const obs of input.observations) {
    for (const target of input.targets) {
      verdicts.push(...verdictForObservationAndTarget(obs, target));
    }
  }
  return verdicts;
}

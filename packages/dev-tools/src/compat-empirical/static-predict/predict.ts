/**
 * Static prediction step.
 *
 * Wraps the public APIs in agent-skills + claude-marketplace to produce a
 * StaticPrediction per skill, capturing both the capability observations
 * VAT derives from the markdown and the per-target verdicts the verdict
 * engine emits given the declared targets.
 */

import {
  deriveObservations,
  validateSkill,
  type Observation,
} from '@vibe-agent-toolkit/agent-skills';
import {
  computeVerdicts,
  type Target,
  type Verdict,
} from '@vibe-agent-toolkit/claude-marketplace';

import type {
  PerTargetPrediction,
  StaticPrediction,
  Target as HarnessTarget,
} from '../types.js';

const ALL_TARGETS: readonly HarnessTarget[] = ['claude-chat', 'claude-cowork', 'claude-code'];

function observationToCode(obs: Observation): StaticPrediction['observations'][number] {
  const payload = obs.payload as Record<string, unknown> | undefined;
  return {
    code: obs.code,
    summary: obs.summary,
    ...(payload ? { payload } : {}),
  };
}

function buildPerTargetPrediction(
  target: Target,
  observations: Observation[],
  declared: Target[] | undefined,
): PerTargetPrediction {
  const verdicts: Verdict[] = computeVerdicts({ observations, targets: [target] });

  let outcome: PerTargetPrediction['predictedOutcome'];
  if (declared === undefined) {
    outcome = 'undeclared';
  } else if (!declared.includes(target)) {
    outcome = 'undeclared';
  } else if (verdicts.some((v) => v.code === 'COMPAT_TARGET_INCOMPATIBLE')) {
    outcome = 'incompatible';
  } else if (verdicts.some((v) => v.code === 'COMPAT_TARGET_NEEDS_REVIEW')) {
    outcome = 'needs-review';
  } else {
    outcome = 'expected';
  }

  return {
    target,
    verdicts: verdicts.map((v) => ({
      code: v.code,
      observationCode: v.observationCode,
      summary: v.summary,
    })),
    predictedOutcome: outcome,
  };
}

export interface PredictOptions {
  skillId: string;
  skillPath: string;
  declaredTargets?: Target[] | undefined;
  vatVersion: string;
}

function errorPrediction(skillId: string, vatVersion: string, message: string): StaticPrediction {
  return {
    skillId,
    observations: [],
    verdictByTarget: ALL_TARGETS.map((t) => ({
      target: t,
      verdicts: [],
      predictedOutcome: 'undeclared' as const,
    })),
    vatVersion,
    predictionError: message,
  };
}

export async function predictForSkill(options: PredictOptions): Promise<StaticPrediction> {
  const { skillId, skillPath, declaredTargets, vatVersion } = options;

  try {
    const result = await validateSkill({ skillPath });

    // validateSkill does not throw on malformed SKILL.md — it returns
    // status: 'error' with issues and leaves evidence undefined. Surface
    // that as a prediction error so the matrix doesn't silently treat a
    // failed validation as "no observations, expected on every target."
    if (result.status === 'error') {
      const errorIssues = result.issues.filter((i) => i.severity === 'error');
      const summary = errorIssues.map((i) => `${i.code}: ${i.message}`).join('; ') || result.summary;
      return errorPrediction(skillId, vatVersion, `validateSkill failed: ${summary}`);
    }

    const evidence = result.evidence ?? [];
    const observations = deriveObservations(evidence);

    const verdictByTarget: PerTargetPrediction[] = ALL_TARGETS.map((t) =>
      buildPerTargetPrediction(t, observations, declaredTargets),
    );

    return {
      skillId,
      observations: observations.map(observationToCode),
      verdictByTarget,
      vatVersion,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorPrediction(skillId, vatVersion, message);
  }
}

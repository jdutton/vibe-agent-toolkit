/**
 * Pure function: join predictions + runtime observations + judgments into
 * one row per (skillId, target).
 */

import { classifyDeterministic } from '../judge/deterministic.js';
import type {
  Agreement,
  Bucket,
  DeterministicClass,
  JoinedMatrixRow,
  JudgeResult,
  JudgeVerdict,
  PerTargetPrediction,
  RuntimeObservation,
  StaticPrediction,
  Target,
} from '../types.js';

function key(skillId: string, target: Target): string {
  return `${skillId}::${target}`;
}

function runtimeSucceeded(deterministic: DeterministicClass, judge: JudgeVerdict | undefined): boolean {
  return deterministic === 'invoked-output' && (judge === undefined || judge === 'completed');
}

function runtimeFailed(deterministic: DeterministicClass, judge: JudgeVerdict | undefined): boolean {
  // TASK-7-WILL-REPLACE: temporary mapping for new 9-value DeterministicClass.
  // Task 7 rewrites these predicates with proper succeeded/failed semantics
  // (including refused, install-failed, runtime-error, and not-invoked-* splits).
  return (
    deterministic === 'install-failed' ||
    deterministic === 'runtime-error' ||
    deterministic === 'refused' ||
    deterministic === 'not-invoked-engaged' ||
    deterministic === 'not-invoked-empty' ||
    deterministic === 'timeout' ||
    judge === 'failed' ||
    judge === 'off-task' ||
    judge === 'refused'
  );
}

function classifyWhenPredictedExpected(succeeded: boolean, failed: boolean): Agreement {
  if (succeeded) return 'agree';
  if (failed) return 'vat-optimistic';
  return 'ambiguous';
}

function classifyWhenPredictedSkeptical(succeeded: boolean, failed: boolean): Agreement {
  if (failed) return 'agree';
  if (succeeded) return 'vat-pessimistic';
  return 'ambiguous';
}

/**
 * The agreement classifier collapses (predicted × deterministic × judge) into
 * a single label. Heuristic per the design doc:
 *  - "agree" — VAT and reality both indicate the same outcome.
 *  - "vat-pessimistic" — VAT said incompatible / needs-review, runtime worked.
 *  - "vat-optimistic" — VAT said expected, runtime failed.
 *  - "ambiguous" — otherwise (mixed signals; the report calls these out).
 */
function classifyAgreement(
  predicted: PerTargetPrediction['predictedOutcome'],
  deterministic: DeterministicClass,
  judge: JudgeVerdict | undefined,
): Agreement {
  const succeeded = runtimeSucceeded(deterministic, judge);
  const failed = runtimeFailed(deterministic, judge);

  if (predicted === 'expected') {
    return classifyWhenPredictedExpected(succeeded, failed);
  }
  if (predicted === 'incompatible' || predicted === 'needs-review') {
    return classifyWhenPredictedSkeptical(succeeded, failed);
  }
  // predicted === 'undeclared' — only call out a clear failure; otherwise ambiguous.
  return failed ? 'agree' : 'ambiguous';
}

function collectEvidenceRefs(prediction: StaticPrediction, target: Target): string[] {
  const refs: string[] = [];
  refs.push(...prediction.observations.map((o) => `obs:${o.code}`));
  const perTarget = prediction.verdictByTarget.find((v) => v.target === target);
  if (perTarget) {
    refs.push(...perTarget.verdicts.map((v) => `verdict:${v.code}:${v.observationCode}`));
  }
  return refs;
}

export interface JoinOptions {
  predictions: readonly StaticPrediction[];
  observations: readonly RuntimeObservation[];
  judgments: readonly JudgeResult[];
  bucketBySkillId: ReadonlyMap<string, Bucket>;
}

function buildRow(args: {
  prediction: StaticPrediction;
  perTarget: PerTargetPrediction;
  bucket: Bucket;
  obs: RuntimeObservation | undefined;
  judge: JudgeResult | undefined;
}): JoinedMatrixRow {
  const { prediction, perTarget, bucket, obs, judge } = args;
  const deterministic: DeterministicClass = obs ? classifyDeterministic(obs) : 'skipped';

  const row: JoinedMatrixRow = {
    skillId: prediction.skillId,
    bucket,
    target: perTarget.target,
    // TASK-7-WILL-REPLACE: temporary single-prompt path; Task 7 joins per
    // (skillId, promptId, target) and aggregates attemptStats from all
    // observations. For now we surface the observed promptId if present
    // (else a placeholder) so the schema accepts the row.
    promptId: obs?.promptId ?? 'fixture-prompt',
    predicted: perTarget.predictedOutcome,
    observedDeterministic: deterministic,
    agreement: classifyAgreement(perTarget.predictedOutcome, deterministic, judge?.verdict),
    driverMode: obs?.driverMode ?? 'manual',
    evidenceRefs: collectEvidenceRefs(prediction, perTarget.target),
    // TASK-7-WILL-REPLACE: temporary single-attempt stats; Task 7 aggregates
    // across attemptIdx for the (skillId, promptId, target) cell.
    attemptStats: {
      n: 1,
      extendedFromN3: false,
      byDeterministicClass: { [deterministic]: 1 },
      byJudgeVerdict: judge ? { [judge.verdict]: 1 } : {},
    },
    highVariance: false,
  };
  if (judge !== undefined) {
    row.observedJudge = judge.verdict;
  }
  return row;
}

export function joinMatrix(options: JoinOptions): JoinedMatrixRow[] {
  const { predictions, observations, judgments, bucketBySkillId } = options;

  const obsIndex = new Map<string, RuntimeObservation>();
  for (const o of observations) {
    obsIndex.set(key(o.skillId, o.target), o);
  }

  const judgeIndex = new Map<string, JudgeResult>();
  for (const j of judgments) {
    judgeIndex.set(key(j.skillId, j.target), j);
  }

  const rows: JoinedMatrixRow[] = [];

  for (const prediction of predictions) {
    const bucket = bucketBySkillId.get(prediction.skillId);
    if (!bucket) {
      // Skill ran predict but has no manifest entry — skip; the manifest is
      // the source of truth for bucket assignment.
      continue;
    }
    for (const perTarget of prediction.verdictByTarget) {
      const obs = obsIndex.get(key(prediction.skillId, perTarget.target));
      const judge = judgeIndex.get(key(prediction.skillId, perTarget.target));
      rows.push(buildRow({ prediction, perTarget, bucket, obs, judge }));
    }
  }

  return rows;
}

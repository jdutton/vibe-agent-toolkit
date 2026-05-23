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
  return (
    deterministic === 'error' ||
    deterministic === 'not-invoked' ||
    deterministic === 'timeout' ||
    judge === 'failed' ||
    judge === 'off-task'
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

      const deterministic: DeterministicClass = obs
        ? classifyDeterministic(obs)
        : 'skipped';

      const row: JoinedMatrixRow = {
        skillId: prediction.skillId,
        bucket,
        target: perTarget.target,
        predicted: perTarget.predictedOutcome,
        observedDeterministic: deterministic,
        agreement: classifyAgreement(perTarget.predictedOutcome, deterministic, judge?.verdict),
        driverMode: obs?.driverMode ?? 'manual',
        evidenceRefs: collectEvidenceRefs(prediction, perTarget.target),
      };

      if (judge !== undefined) {
        row.observedJudge = judge.verdict;
      }

      rows.push(row);
    }
  }

  return rows;
}

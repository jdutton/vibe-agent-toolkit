/**
 * Pure function: join predictions + runtime observations + judgments into
 * one row per (skillId, target, promptId).
 *
 * Multiple prompts per (skill, target) are first-class: every prompt referenced
 * by a corpus entry produces its own row, so the matrix doesn't silently drop
 * cells when a skill has both a positive and a negative prompt (the manifest
 * validator already requires ≥1 of each). When `repeatN > 1` each observation
 * group aggregates per-attempt counts into `attemptStats` and surfaces the mode
 * as the cell's primary deterministic/judge label.
 */

import { classifyDeterministic } from '../judge/deterministic.js';
import type {
  Agreement,
  AttemptStats,
  Bucket,
  DeterministicClass,
  JoinedMatrixRow,
  JudgeResult,
  JudgeVerdict,
  PerTargetPrediction,
  RuntimeObservation,
  StaticPrediction,
  Target,
  TriggerPrompt,
} from '../types.js';

/**
 * Sentinel promptId stamped on "skipped" rows — (skill, target) cells with
 * zero observations. The schema requires a string promptId and the renderer
 * surfaces this as-is in the prompt column, so a sentinel keeps skipped cells
 * grouped sensibly when sorted and visually distinct from real prompt IDs.
 */
const SKIPPED_PROMPT_ID = '-';

function cellKey(skillId: string, target: Target, promptId: string): string {
  return `${skillId}::${target}::${promptId}`;
}

function runtimeSucceeded(deterministic: DeterministicClass, judge: JudgeVerdict | undefined): boolean {
  return deterministic === 'invoked-output' && (judge === undefined || judge === 'completed');
}

function runtimeFailed(deterministic: DeterministicClass, judge: JudgeVerdict | undefined): boolean {
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
 *
 * Negative-prompt inversion (see design doc §1 "Negative prompts"): when the
 * triggering prompt is a `negative`, the *desired* runtime outcome is NO
 * trigger. A successful invocation on a negative prompt is therefore a
 * false-positive trigger. We flip the runtime success/failure booleans before
 * classifying so the agreement label reflects the negative-prompt contract
 * (e.g. predicted=expected + triggered + negative → vat-optimistic).
 */
function classifyAgreement(
  predicted: PerTargetPrediction['predictedOutcome'],
  deterministic: DeterministicClass,
  judge: JudgeVerdict | undefined,
  isNegativePrompt: boolean,
): Agreement {
  const rawSucceeded = runtimeSucceeded(deterministic, judge);
  const rawFailed = runtimeFailed(deterministic, judge);
  const succeeded = isNegativePrompt ? rawFailed : rawSucceeded;
  const failed = isNegativePrompt ? rawSucceeded : rawFailed;

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
  /**
   * Lookup map from `TriggerPrompt.id` to the prompt itself, used to identify
   * negative prompts so the join classifier can invert success/failure
   * semantics for them.
   */
  promptById: ReadonlyMap<string, TriggerPrompt>;
}

function pickMode<T extends string>(counts: Record<string, number>, fallback: T): T {
  let bestKey: string | undefined;
  let bestCount = -1;
  for (const [k, n] of Object.entries(counts)) {
    if (n > bestCount) {
      bestCount = n;
      bestKey = k;
    }
  }
  return (bestKey ?? fallback) as T;
}

function aggregateObservations(observations: readonly RuntimeObservation[]): {
  primaryDet: DeterministicClass;
  byDet: Record<DeterministicClass, number>;
} {
  const byDet: Partial<Record<DeterministicClass, number>> = {};
  for (const obs of observations) {
    const cls = classifyDeterministic(obs);
    byDet[cls] = (byDet[cls] ?? 0) + 1;
  }
  const primaryDet = pickMode<DeterministicClass>(byDet as Record<string, number>, 'skipped');
  return { primaryDet, byDet: byDet as Record<DeterministicClass, number> };
}

function aggregateJudgments(judgments: readonly JudgeResult[]): {
  primaryJudge: JudgeVerdict | undefined;
  byJudge: Record<JudgeVerdict, number>;
} {
  const byJudge: Partial<Record<JudgeVerdict, number>> = {};
  for (const j of judgments) {
    byJudge[j.verdict] = (byJudge[j.verdict] ?? 0) + 1;
  }
  if (judgments.length === 0) {
    return { primaryJudge: undefined, byJudge: byJudge as Record<JudgeVerdict, number> };
  }
  const primaryJudge = pickMode<JudgeVerdict>(byJudge as Record<string, number>, 'completed');
  return { primaryJudge, byJudge: byJudge as Record<JudgeVerdict, number> };
}

function makeAttemptStats(
  n: number,
  byDet: Record<DeterministicClass, number>,
  byJudge: Record<JudgeVerdict, number>,
): AttemptStats {
  return {
    n: Math.max(n, 1),
    extendedFromN3: false,
    byDeterministicClass: byDet,
    byJudgeVerdict: byJudge,
  };
}

function buildObservedRow(args: {
  prediction: StaticPrediction;
  perTarget: PerTargetPrediction;
  bucket: Bucket;
  promptId: string;
  observations: readonly RuntimeObservation[];
  judgments: readonly JudgeResult[];
  isNegativePrompt: boolean;
}): JoinedMatrixRow {
  const { prediction, perTarget, bucket, promptId, observations, judgments, isNegativePrompt } = args;
  const { primaryDet, byDet } = aggregateObservations(observations);
  const { primaryJudge, byJudge } = aggregateJudgments(judgments);
  const driverMode = observations[0]?.driverMode ?? 'manual';

  const row: JoinedMatrixRow = {
    skillId: prediction.skillId,
    bucket,
    target: perTarget.target,
    promptId,
    predicted: perTarget.predictedOutcome,
    observedDeterministic: primaryDet,
    agreement: classifyAgreement(perTarget.predictedOutcome, primaryDet, primaryJudge, isNegativePrompt),
    driverMode,
    evidenceRefs: collectEvidenceRefs(prediction, perTarget.target),
    attemptStats: makeAttemptStats(observations.length, byDet, byJudge),
    highVariance: false,
  };
  if (primaryJudge !== undefined) {
    row.observedJudge = primaryJudge;
  }
  return row;
}

function buildSkippedRow(args: {
  prediction: StaticPrediction;
  perTarget: PerTargetPrediction;
  bucket: Bucket;
}): JoinedMatrixRow {
  const { prediction, perTarget, bucket } = args;
  return {
    skillId: prediction.skillId,
    bucket,
    target: perTarget.target,
    promptId: SKIPPED_PROMPT_ID,
    predicted: perTarget.predictedOutcome,
    observedDeterministic: 'skipped',
    agreement: classifyAgreement(perTarget.predictedOutcome, 'skipped', undefined, false),
    driverMode: 'manual',
    evidenceRefs: collectEvidenceRefs(prediction, perTarget.target),
    attemptStats: {
      n: 1,
      extendedFromN3: false,
      byDeterministicClass: { skipped: 1 },
      byJudgeVerdict: {},
    },
    highVariance: false,
  };
}

function groupByCellKey<T extends { skillId: string; target: Target; promptId: string }>(
  items: readonly T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = cellKey(it.skillId, it.target, it.promptId);
    const list = out.get(k) ?? [];
    list.push(it);
    out.set(k, list);
  }
  return out;
}

function collectPromptIdsForCell(
  observations: readonly RuntimeObservation[],
  skillId: string,
  target: Target,
): string[] {
  const seen = new Set<string>();
  for (const o of observations) {
    if (o.skillId === skillId && o.target === target) {
      seen.add(o.promptId);
    }
  }
  // Stable order for diffable output.
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function joinMatrix(options: JoinOptions): JoinedMatrixRow[] {
  const { predictions, observations, judgments, bucketBySkillId, promptById } = options;

  const obsByCell = groupByCellKey(observations);
  const judgesByCell = groupByCellKey(judgments);

  const rows: JoinedMatrixRow[] = [];

  for (const prediction of predictions) {
    const bucket = bucketBySkillId.get(prediction.skillId);
    if (!bucket) continue;

    for (const perTarget of prediction.verdictByTarget) {
      const promptIds = collectPromptIdsForCell(observations, prediction.skillId, perTarget.target);

      if (promptIds.length === 0) {
        rows.push(buildSkippedRow({ prediction, perTarget, bucket }));
        continue;
      }

      for (const promptId of promptIds) {
        const k = cellKey(prediction.skillId, perTarget.target, promptId);
        const cellObs = obsByCell.get(k) ?? [];
        const cellJudges = judgesByCell.get(k) ?? [];
        const prompt = promptById.get(promptId);
        const isNegativePrompt = prompt?.kind === 'negative';
        rows.push(
          buildObservedRow({
            prediction,
            perTarget,
            bucket,
            promptId,
            observations: cellObs,
            judgments: cellJudges,
            isNegativePrompt,
          }),
        );
      }
    }
  }

  return rows;
}

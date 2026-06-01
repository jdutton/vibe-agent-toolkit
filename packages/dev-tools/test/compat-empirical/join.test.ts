import { describe, expect, it } from 'vitest';

import { joinMatrix } from '../../src/compat-empirical/report/join.js';
import type {
  Bucket,
  JudgeResult,
  RuntimeObservation,
  StaticPrediction,
  Target,
  TriggerPrompt,
} from '../../src/compat-empirical/types.js';

const ALL_TARGETS: readonly Target[] = ['claude-chat', 'claude-cowork', 'claude-code'];
const TARGET_CODE: Target = 'claude-code';
const TARGET_CHAT: Target = 'claude-chat';
const FAKE_TRANSCRIPT = 'tests/fake-transcript.log';
const DET_INVOKED_OUTPUT = 'invoked-output';

function makePrediction(skillId: string, overrides: Partial<StaticPrediction> = {}): StaticPrediction {
  return {
    skillId,
    observations: [],
    verdictByTarget: ALL_TARGETS.map((t) => ({
      target: t,
      verdicts: [],
      predictedOutcome: 'expected' as const,
    })),
    vatVersion: 'test',
    ...overrides,
  };
}

function makeObservation(skillId: string, target: Target, overrides: Partial<RuntimeObservation> = {}): RuntimeObservation {
  return {
    skillId,
    target,
    startedAt: '2026-05-22T00:00:00.000Z',
    durationMs: 1,
    exitStatus: 'completed',
    invocationDetected: true,
    outputText: 'output',
    toolUseEvents: [],
    errors: [],
    installResult: { ok: true, notes: '' },
    transcriptPath: FAKE_TRANSCRIPT,
    driverMode: 'scripted',
    promptId: 'fixture-prompt',
    attemptIdx: 0,
    ...overrides,
  };
}

function judge(
  skillId: string,
  target: Target,
  verdict: JudgeResult['verdict'],
  overrides: Partial<Pick<JudgeResult, 'promptId' | 'attemptIdx'>> = {},
): JudgeResult {
  return {
    skillId,
    target,
    promptId: overrides.promptId ?? 'fixture-prompt',
    attemptIdx: overrides.attemptIdx ?? 0,
    verdict,
    rationale: 'r',
    confidence: 'high',
    judgeModel: 'm',
  };
}

const bucketMap = (id: string, b: Bucket): Map<string, Bucket> => new Map([[id, b]]);

/**
 * Wraps a `joinMatrix` call with the empty-`promptById` default that most
 * fixtures want, so individual tests don't have to repeat the
 * `new Map<string, TriggerPrompt>()` boilerplate (sonarjs/no-duplicate-string
 * + jscpd both flagged the repetition).
 */
function runJoin(args: {
  predictions: readonly StaticPrediction[];
  observations: readonly RuntimeObservation[];
  judgments: readonly JudgeResult[];
  bucketBySkillId: ReadonlyMap<string, Bucket>;
  promptById?: ReadonlyMap<string, TriggerPrompt>;
}): ReturnType<typeof joinMatrix> {
  return joinMatrix({
    predictions: args.predictions,
    observations: args.observations,
    judgments: args.judgments,
    bucketBySkillId: args.bucketBySkillId,
    promptById: args.promptById ?? new Map<string, TriggerPrompt>(),
  });
}

describe('joinMatrix', () => {
  it('produces one row per declared (skill, target) pair', () => {
    const rows = runJoin({
      predictions: [makePrediction('s1')],
      observations: [],
      judgments: [],
      bucketBySkillId: bucketMap('s1', 'own'),
    });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.target))).toEqual(new Set(ALL_TARGETS));
  });

  it('classifies agree when prediction expected + invoked output + judge completed', () => {
    const rows = runJoin({
      predictions: [makePrediction('s1')],
      observations: [makeObservation('s1', TARGET_CODE)],
      judgments: [judge('s1', TARGET_CODE, 'completed')],
      bucketBySkillId: bucketMap('s1', 'own'),
    });
    const row = rows.find((r) => r.target === TARGET_CODE);
    expect(row?.agreement).toBe('agree');
    expect(row?.observedDeterministic).toBe(DET_INVOKED_OUTPUT);
    expect(row?.observedJudge).toBe('completed');
  });

  it('classifies vat-optimistic when predicted expected but runtime failed', () => {
    const rows = runJoin({
      predictions: [makePrediction('s1')],
      observations: [makeObservation('s1', TARGET_CODE, { exitStatus: 'error' })],
      judgments: [judge('s1', TARGET_CODE, 'failed')],
      bucketBySkillId: bucketMap('s1', 'own'),
    });
    const row = rows.find((r) => r.target === TARGET_CODE);
    expect(row?.agreement).toBe('vat-optimistic');
  });

  it('classifies vat-pessimistic when predicted incompatible but runtime succeeded', () => {
    const incompatiblePrediction = makePrediction('s1', {
      verdictByTarget: [
        { target: TARGET_CHAT, verdicts: [], predictedOutcome: 'incompatible' },
        { target: 'claude-cowork' as Target, verdicts: [], predictedOutcome: 'expected' },
        { target: TARGET_CODE, verdicts: [], predictedOutcome: 'expected' },
      ],
    });
    const rows = runJoin({
      predictions: [incompatiblePrediction],
      observations: [makeObservation('s1', TARGET_CHAT)],
      judgments: [judge('s1', TARGET_CHAT, 'completed')],
      bucketBySkillId: bucketMap('s1', 'own'),
    });
    const row = rows.find((r) => r.target === TARGET_CHAT);
    expect(row?.agreement).toBe('vat-pessimistic');
  });

  it('skips skills not present in bucketBySkillId', () => {
    const rows = runJoin({
      predictions: [makePrediction('orphan')],
      observations: [],
      judgments: [],
      bucketBySkillId: new Map<string, Bucket>(),
    });
    expect(rows).toHaveLength(0);
  });

  it('emits one row per (skillId, target, promptId) when a cell has multiple prompts', () => {
    // Regression: prior to the per-prompt join, observations for the same
    // (skillId, target) but different promptIds collapsed via Map.set
    // overwrite — only the last-iterated prompt survived in the matrix and
    // the others were silently dropped. This test pins the per-prompt
    // behavior so the bug can't come back.
    const POS_ID = 'pos-1';
    const NEG_ID = 'neg-1';
    const positivePrompt: TriggerPrompt = {
      id: POS_ID,
      forSkillId: 's1',
      prompt: 'do the thing',
      kind: 'positive',
      expectedBehavior: { description: 'should invoke', invocationSignals: ['ok'] },
      authoring: 'hand',
    };
    const negativePrompt: TriggerPrompt = {
      id: NEG_ID,
      forSkillId: 's1',
      prompt: 'unrelated',
      kind: 'negative',
      expectedBehavior: { description: 'should not invoke', invocationSignals: ['ok'] },
      authoring: 'hand',
    };
    const promptById = new Map<string, TriggerPrompt>([
      [POS_ID, positivePrompt],
      [NEG_ID, negativePrompt],
    ]);

    const positiveObs = makeObservation('s1', TARGET_CODE, {
      promptId: POS_ID,
      invocationDetected: true,
      outputText: 'ok',
    });
    const negativeObs = makeObservation('s1', TARGET_CODE, {
      promptId: NEG_ID,
      invocationDetected: false,
      outputText: '4',
      toolUseEvents: [],
    });

    const rows = runJoin({
      predictions: [makePrediction('s1')],
      observations: [positiveObs, negativeObs],
      judgments: [
        judge('s1', TARGET_CODE, 'completed', { promptId: POS_ID }),
        judge('s1', TARGET_CODE, 'completed', { promptId: NEG_ID }),
      ],
      bucketBySkillId: bucketMap('s1', 'own'),
      promptById,
    });

    // 2 observed rows for CODE (one per prompt) + 1 skipped row each for CHAT and COWORK.
    expect(rows).toHaveLength(4);
    const codeRows = rows.filter((r) => r.target === TARGET_CODE);
    expect(codeRows).toHaveLength(2);
    const byPrompt = new Map(codeRows.map((r) => [r.promptId, r]));
    expect(byPrompt.get(POS_ID)?.observedDeterministic).toBe(DET_INVOKED_OUTPUT);
    expect(byPrompt.get(POS_ID)?.observedJudge).toBe('completed');
    expect(byPrompt.get(POS_ID)?.agreement).toBe('agree');
    expect(byPrompt.get(NEG_ID)?.observedDeterministic).toBe('not-invoked-engaged');
    expect(byPrompt.get(NEG_ID)?.observedJudge).toBe('completed');
    // Negative prompt that didn't trigger + predicted=expected → agree
    // (negative inversion flips the runtime success/failure booleans).
    expect(byPrompt.get(NEG_ID)?.agreement).toBe('agree');
  });

  it('aggregates per-attempt counts when repeatN > 1 for a (skillId, target, promptId) cell', () => {
    const promptById = new Map<string, TriggerPrompt>();
    const observations = [
      makeObservation('s1', TARGET_CODE, { attemptIdx: 0, invocationDetected: true, outputText: 'ok' }),
      makeObservation('s1', TARGET_CODE, { attemptIdx: 1, invocationDetected: true, outputText: 'ok' }),
      makeObservation('s1', TARGET_CODE, { attemptIdx: 2, invocationDetected: false, outputText: 'wat' }),
    ];

    const rows = runJoin({
      predictions: [makePrediction('s1')],
      observations,
      judgments: [
        judge('s1', TARGET_CODE, 'completed', { attemptIdx: 0 }),
        judge('s1', TARGET_CODE, 'completed', { attemptIdx: 1 }),
        judge('s1', TARGET_CODE, 'failed', { attemptIdx: 2 }),
      ],
      bucketBySkillId: bucketMap('s1', 'own'),
      promptById,
    });

    const codeRow = rows.find((r) => r.target === TARGET_CODE);
    expect(codeRow?.attemptStats.n).toBe(3);
    expect(codeRow?.attemptStats.byDeterministicClass[DET_INVOKED_OUTPUT]).toBe(2);
    expect(codeRow?.attemptStats.byDeterministicClass['not-invoked-engaged']).toBe(1);
    expect(codeRow?.attemptStats.byJudgeVerdict['completed']).toBe(2);
    expect(codeRow?.attemptStats.byJudgeVerdict['failed']).toBe(1);
    // Mode wins for the displayed cell.
    expect(codeRow?.observedDeterministic).toBe(DET_INVOKED_OUTPUT);
    expect(codeRow?.observedJudge).toBe('completed');
  });

  it('inverts agreement for negative prompts that trigger the skill', () => {
    const SKILL_ID = 'skill-a';
    const negativePrompt: TriggerPrompt = {
      id: 'neg-1',
      forSkillId: SKILL_ID,
      prompt: 'q',
      kind: 'negative',
      expectedBehavior: { description: 'should not invoke', invocationSignals: ['thing'] },
      authoring: 'hand',
    };
    const promptById = new Map<string, TriggerPrompt>([['neg-1', negativePrompt]]);

    const prediction: StaticPrediction = {
      skillId: SKILL_ID,
      vatVersion: '0.1.x',
      observations: [],
      verdictByTarget: [
        { target: TARGET_CODE, verdicts: [], predictedOutcome: 'expected' },
      ],
    };

    const observation: RuntimeObservation = {
      skillId: SKILL_ID,
      target: TARGET_CODE,
      startedAt: '2026-05-22T00:00:00.000Z',
      durationMs: 10,
      exitStatus: 'completed',
      invocationDetected: true,
      outputText: 'thing',
      toolUseEvents: [],
      errors: [],
      installResult: { ok: true, notes: 'ok' },
      transcriptPath: FAKE_TRANSCRIPT,
      driverMode: 'scripted',
      promptId: 'neg-1',
      attemptIdx: 0,
    };

    const rows = runJoin({
      predictions: [prediction],
      observations: [observation],
      judgments: [],
      bucketBySkillId: bucketMap(SKILL_ID, 'own'),
      promptById,
    });

    expect(rows).toHaveLength(1);
    // Agent triggered on a negative prompt → false-positive trigger.
    // VAT predicted "expected" (which for a positive prompt means "should work"),
    // but for a negative prompt the desired outcome is NO trigger. So this is
    // optimistic — VAT was overly permissive.
    expect(rows[0]?.agreement).toBe('vat-optimistic');
  });
});

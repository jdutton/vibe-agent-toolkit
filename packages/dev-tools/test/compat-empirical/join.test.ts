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

function judge(skillId: string, target: Target, verdict: JudgeResult['verdict']): JudgeResult {
  return {
    skillId,
    target,
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
    expect(row?.observedDeterministic).toBe('invoked-output');
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

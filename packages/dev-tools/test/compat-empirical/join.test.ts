import { describe, expect, it } from 'vitest';

import { joinMatrix } from '../../src/compat-empirical/report/join.js';
import type {
  Bucket,
  JudgeResult,
  RuntimeObservation,
  StaticPrediction,
  Target,
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

describe('joinMatrix', () => {
  it('produces one row per declared (skill, target) pair', () => {
    const rows = joinMatrix({
      predictions: [makePrediction('s1')],
      observations: [],
      judgments: [],
      bucketBySkillId: bucketMap('s1', 'own'),
    });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.target))).toEqual(new Set(ALL_TARGETS));
  });

  it('classifies agree when prediction expected + invoked output + judge completed', () => {
    const rows = joinMatrix({
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
    const rows = joinMatrix({
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
    const rows = joinMatrix({
      predictions: [incompatiblePrediction],
      observations: [makeObservation('s1', TARGET_CHAT)],
      judgments: [judge('s1', TARGET_CHAT, 'completed')],
      bucketBySkillId: bucketMap('s1', 'own'),
    });
    const row = rows.find((r) => r.target === TARGET_CHAT);
    expect(row?.agreement).toBe('vat-pessimistic');
  });

  it('skips skills not present in bucketBySkillId', () => {
    const rows = joinMatrix({
      predictions: [makePrediction('orphan')],
      observations: [],
      judgments: [],
      bucketBySkillId: new Map<string, Bucket>(),
    });
    expect(rows).toHaveLength(0);
  });
});

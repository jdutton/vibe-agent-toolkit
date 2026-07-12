import { describe, expect, it } from 'vitest';

import { renderReport } from '../../src/compat-empirical/report/render-md.js';
import type {
  AttemptStats,
  JoinedMatrixRow,
  RunMetadata,
} from '../../src/compat-empirical/types.js';

const JUDGE_MODEL = 'claude-sonnet-5';
const TARGET_CODE = 'claude-code' as const;
const TARGET_CHAT = 'claude-chat' as const;
const SKILL_SKIPPED = 's-skipped';
const BUCKET_OFFICIAL = 'official' as const;
const DET_RUNTIME_ERROR = 'runtime-error' as const;
const DET_INVOKED_NO_OUTPUT = 'invoked-no-output' as const;

function meta(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    runId: '00000000-0000-0000-0000-000000000000',
    runDate: '2026-05-22T00:00:00.000Z',
    vatVersion: '0.1.37',
    nodeVersion: 'v22.0.0',
    judgeModel: JUDGE_MODEL,
    authMode: 'subscription',
    judgePromptSha: 'aaaaaaaaaaaaaaaa',
    triggerPromptsSha: 'bbbbbbbbbbbbbbbb',
    manifestSha: 'cccccccccccccccc',
    runtimesCovered: [TARGET_CODE],
    totalEntries: 2,
    ...overrides,
  };
}

const FIXTURE_PROMPT = 'fixture-prompt';
const EMPTY_ATTEMPT_STATS: AttemptStats = {
  n: 1,
  extendedFromN3: false,
  byDeterministicClass: {},
  byJudgeVerdict: {},
};

function row(overrides: Partial<JoinedMatrixRow> = {}): JoinedMatrixRow {
  return {
    skillId: 's1',
    bucket: 'own',
    target: TARGET_CODE,
    promptId: FIXTURE_PROMPT,
    predicted: 'expected',
    observedDeterministic: 'invoked-output',
    observedJudge: 'completed',
    agreement: 'agree',
    driverMode: 'scripted',
    evidenceRefs: [],
    attemptStats: EMPTY_ATTEMPT_STATS,
    highVariance: false,
    ...overrides,
  };
}

/** Standard "skipped" row used across the coverage tests. */
function skippedRow(overrides: Partial<JoinedMatrixRow> = {}): JoinedMatrixRow {
  return row({
    skillId: SKILL_SKIPPED,
    observedDeterministic: 'skipped',
    observedJudge: undefined,
    agreement: 'ambiguous',
    ...overrides,
  });
}

const sampleRows: JoinedMatrixRow[] = [
  row(),
  row({
    target: TARGET_CHAT,
    predicted: 'incompatible',
    observedDeterministic: DET_RUNTIME_ERROR,
    observedJudge: undefined,
    driverMode: 'manual',
  }),
  row({
    skillId: 'community-x',
    bucket: 'community',
    evidenceRefs: [],
  }),
];

describe('renderReport', () => {
  it('includes the [vat: empirical] attribution prefix', () => {
    const out = renderReport({ rows: sampleRows, meta: meta() });
    expect(out.startsWith('# [vat: empirical]')).toBe(true);
  });

  it('names own-bucket skills but aggregates community-bucket rows', () => {
    const out = renderReport({ rows: sampleRows, meta: meta() });
    expect(out).toContain('`s1`');
    expect(out).not.toContain('community-x'); // community must be aggregated
    expect(out).toContain('two-bucket discipline');
  });

  it('renders methodology fields from RunMetadata', () => {
    const out = renderReport({ rows: sampleRows, meta: meta({ vatVersion: '9.9.9' }) });
    expect(out).toContain('VAT version:** 9.9.9');
    expect(out).toContain(JUDGE_MODEL);
  });

  describe('coverage stats + headline', () => {
    it('reports ran/totalPossible with per-runtime breakdown', () => {
      // 3 rows; one is skipped — `ran` should be 2.
      const rows: JoinedMatrixRow[] = [
        row({ target: TARGET_CODE, agreement: 'agree' }),
        row({ target: TARGET_CHAT, agreement: 'agree' }),
        skippedRow({ target: 'claude-cowork' }),
      ];
      const out = renderReport({ rows, meta: meta() });
      expect(out).toContain('Across **2/3 cells ran**');
      expect(out).toMatch(/Code: 1\/1/);
      expect(out).toMatch(/Cowork: 0\/1/);
      expect(out).toMatch(/Chat: 1\/1/);
    });

    it('computes agreement % over ran cells only', () => {
      // 2 ran agree out of 2 ran (the 3rd is skipped) → 100%
      const rows: JoinedMatrixRow[] = [
        row({ agreement: 'agree' }),
        row({ target: TARGET_CHAT, agreement: 'agree' }),
        skippedRow(),
      ];
      const out = renderReport({ rows, meta: meta() });
      expect(out).toContain('100.0%');
    });

    it('includes the skipped-cells note when skipped > 0', () => {
      const rows: JoinedMatrixRow[] = [row({ agreement: 'agree' }), skippedRow()];
      const out = renderReport({ rows, meta: meta() });
      expect(out).toContain('1 cells were skipped');
    });

    it('omits the skipped-cells note when skipped === 0', () => {
      const out = renderReport({ rows: [row()], meta: meta() });
      expect(out).not.toMatch(/cells were skipped/);
    });
  });

  describe('driver modes observed', () => {
    it('lists modes from ran cells but never from skipped cells', () => {
      // A skipped cowork row carries a synthetic driverMode; it must not
      // advertise a mode that was never exercised.
      const rows: JoinedMatrixRow[] = [
        row({ target: TARGET_CODE, driverMode: 'scripted' }),
        skippedRow({ target: 'claude-cowork', driverMode: 'manual' }),
      ];
      const out = renderReport({ rows, meta: meta() });
      expect(out).toContain('- claude-code:scripted');
      expect(out).not.toContain('claude-cowork:manual');
    });

    it('falls back to a placeholder when every cell was skipped', () => {
      const out = renderReport({ rows: [skippedRow()], meta: meta() });
      expect(out).toContain('_none — all cells skipped_');
    });
  });

  describe('per-bucket headline table', () => {
    it('emits one row per bucket with agree-percentage and gray-zone count', () => {
      const rows: JoinedMatrixRow[] = [
        row({ bucket: 'own', agreement: 'agree' }),
        row({ skillId: 's-opt', bucket: 'own', agreement: 'vat-optimistic', observedDeterministic: DET_RUNTIME_ERROR }),
        row({ skillId: 's-off', bucket: BUCKET_OFFICIAL, agreement: 'agree' }),
        row({
          skillId: 's-gray',
          bucket: BUCKET_OFFICIAL,
          agreement: 'ambiguous',
          observedDeterministic: 'not-invoked-engaged',
          observedJudge: undefined,
        }),
      ];
      const out = renderReport({ rows, meta: meta() });
      expect(out).toContain('| bucket | ran | agree | optimistic | pessimistic | gray-zone |');
      // own: 2 ran, 1 agree (50%), 1 optimistic, 0 pess, 0 gray
      expect(out).toMatch(/\| own \| 2 \| 1 \(50\.0%\) \| 1 \| 0 \| 0 \|/);
      // official: 2 ran, 1 agree (50%), 0 opt, 0 pess, 1 gray (not-invoked-engaged matches)
      expect(out).toMatch(/\| official \| 2 \| 1 \(50\.0%\) \| 0 \| 0 \| 1 \|/);
    });
  });

  describe('gray-zone section', () => {
    it('groups rows by pattern with named callouts for own/official', () => {
      const rows: JoinedMatrixRow[] = [
        row({
          skillId: 'judge-softer',
          bucket: 'own',
          observedDeterministic: 'invoked-output',
          observedJudge: 'partial',
          agreement: 'ambiguous',
        }),
        row({
          skillId: 'invoked-empty',
          bucket: BUCKET_OFFICIAL,
          observedDeterministic: DET_INVOKED_NO_OUTPUT,
          observedJudge: undefined,
          agreement: 'ambiguous',
        }),
        row({
          skillId: 'engaged',
          bucket: 'own',
          observedDeterministic: 'not-invoked-engaged',
          observedJudge: undefined,
          agreement: 'vat-optimistic',
        }),
      ];
      const out = renderReport({ rows, meta: meta() });
      expect(out).toContain('### Gray-zone (mixed-signal) cells');
      expect(out).toContain('#### judge-softer-than-det (1 cells)');
      expect(out).toContain('#### invoked-but-empty (1 cells)');
      expect(out).toContain('#### not-invoked-engaged (1 cells)');
      expect(out).toContain('`own:judge-softer`');
      expect(out).toContain('`official:invoked-empty`');
      expect(out).toContain('`own:engaged`');
    });

    it('aggregates community-bucket gray-zone cells as count only', () => {
      const rows: JoinedMatrixRow[] = [
        row({
          skillId: 'comm-skill-a',
          bucket: 'community',
          observedDeterministic: DET_INVOKED_NO_OUTPUT,
          observedJudge: undefined,
          agreement: 'ambiguous',
        }),
        row({
          skillId: 'comm-skill-b',
          bucket: 'community',
          observedDeterministic: DET_INVOKED_NO_OUTPUT,
          observedJudge: undefined,
          agreement: 'ambiguous',
        }),
      ];
      const out = renderReport({ rows, meta: meta() });
      expect(out).toContain('community: 2 cells (aggregated; not named)');
      expect(out).not.toContain('comm-skill-a');
      expect(out).not.toContain('comm-skill-b');
    });

    it('renders an empty-state line when no gray-zone cells exist', () => {
      const out = renderReport({ rows: [row()], meta: meta() });
      expect(out).toContain('_No gray-zone cells in this run._');
    });
  });

  describe('high-variance section', () => {
    it('lists named cells with trigger-rate and completion-rate', () => {
      const rows: JoinedMatrixRow[] = [
        row({
          skillId: 'flaky',
          bucket: 'own',
          highVariance: true,
          attemptStats: {
            n: 5,
            extendedFromN3: true,
            byDeterministicClass: { 'invoked-output': 2, 'not-invoked-engaged': 3 },
            byJudgeVerdict: { completed: 2 },
          },
        }),
      ];
      const out = renderReport({ rows, meta: meta() });
      expect(out).toContain('### High-variance cells (N=5, still ambiguous)');
      expect(out).toContain('`own:flaky` / Code: trigger-rate 2/5, completion 2/5');
    });

    it('aggregates community high-variance as count only', () => {
      const rows: JoinedMatrixRow[] = [
        row({
          skillId: 'community-flaky',
          bucket: 'community',
          highVariance: true,
          attemptStats: {
            n: 5,
            extendedFromN3: true,
            byDeterministicClass: { 'invoked-output': 2, 'runtime-error': 3 },
            byJudgeVerdict: {},
          },
        }),
      ];
      const out = renderReport({ rows, meta: meta() });
      expect(out).toContain('community: 1 cells (aggregated; not named)');
      expect(out).not.toContain('community-flaky');
    });

    it('renders an empty-state line when no high-variance cells exist', () => {
      const out = renderReport({ rows: [row()], meta: meta() });
      expect(out).toContain('_No high-variance cells in this run._');
    });
  });

  describe('per-attempt variance rendering', () => {
    it('renders observed cell as v1 shape when n === 1', () => {
      const out = renderReport({ rows: [row()], meta: meta() });
      // For n=1 the cell is `det / judge` with no fraction.
      expect(out).toContain('invoked-output / completed');
      expect(out).not.toMatch(/invoked-output \(\d+\/\d+\)/);
    });

    it('renders observed cell with per-attempt fractions when n > 1', () => {
      const rows: JoinedMatrixRow[] = [
        row({
          skillId: 'multi',
          attemptStats: {
            n: 3,
            extendedFromN3: false,
            byDeterministicClass: { 'invoked-output': 2, 'runtime-error': 1 },
            byJudgeVerdict: { completed: 2 },
          },
        }),
      ];
      const out = renderReport({ rows, meta: meta() });
      expect(out).toContain('invoked-output (2/3) / completed (2/3)');
    });

    it('renders only the det fraction when judge is undefined and n > 1', () => {
      const rows: JoinedMatrixRow[] = [
        row({
          skillId: 'err',
          target: TARGET_CODE,
          observedDeterministic: DET_RUNTIME_ERROR,
          observedJudge: undefined,
          attemptStats: {
            n: 3,
            extendedFromN3: false,
            byDeterministicClass: { 'runtime-error': 3 },
            byJudgeVerdict: {},
          },
        }),
      ];
      const out = renderReport({ rows, meta: meta() });
      expect(out).toContain('runtime-error (3/3)');
      // No "/ <judge>" segment for an undefined judge.
      expect(out).not.toMatch(/runtime-error \(3\/3\) \/ /);
    });
  });
});

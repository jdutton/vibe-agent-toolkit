import { describe, expect, it } from 'vitest';

import { renderReport } from '../../src/compat-empirical/report/render-md.js';
import type {
  JoinedMatrixRow,
  RunMetadata,
} from '../../src/compat-empirical/types.js';

const JUDGE_MODEL = 'claude-sonnet-4-6';
const TARGET_CODE = 'claude-code' as const;

function meta(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    runId: '00000000-0000-0000-0000-000000000000',
    runDate: '2026-05-22T00:00:00.000Z',
    vatVersion: '0.1.37',
    nodeVersion: 'v22.0.0',
    judgeModel: JUDGE_MODEL,
    judgePromptSha: 'aaaaaaaaaaaaaaaa',
    triggerPromptsSha: 'bbbbbbbbbbbbbbbb',
    manifestSha: 'cccccccccccccccc',
    runtimesCovered: [TARGET_CODE],
    totalEntries: 2,
    ...overrides,
  };
}

const sampleRows: JoinedMatrixRow[] = [
  {
    skillId: 's1', bucket: 'own', target: TARGET_CODE,
    predicted: 'expected', observedDeterministic: 'invoked-output', observedJudge: 'completed',
    agreement: 'agree', driverMode: 'scripted', evidenceRefs: ['obs:CAPABILITY_LOCAL_SHELL'],
  },
  {
    skillId: 's1', bucket: 'own', target: 'claude-chat',
    predicted: 'incompatible', observedDeterministic: 'error',
    agreement: 'agree', driverMode: 'manual', evidenceRefs: [],
  },
  {
    skillId: 'community-x', bucket: 'community', target: TARGET_CODE,
    predicted: 'expected', observedDeterministic: 'invoked-output', observedJudge: 'completed',
    agreement: 'agree', driverMode: 'scripted', evidenceRefs: [],
  },
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

  it('emits a headline agreement percentage', () => {
    const out = renderReport({ rows: sampleRows, meta: meta() });
    // 3 of 3 rows agree
    expect(out).toMatch(/agreement.*100\.0%|100\.0%/);
  });

  it('renders methodology fields from RunMetadata', () => {
    const out = renderReport({ rows: sampleRows, meta: meta({ vatVersion: '9.9.9' }) });
    expect(out).toContain('VAT version:** 9.9.9');
    expect(out).toContain(JUDGE_MODEL);
  });
});

/**
 * `withRunIntegrity` is the single point that decides "examined nothing" for
 * every report: it adds the one `RESOURCE_CHECK_BROKEN` refusal-as-finding
 * behind one precedence — an existing refusal-kind finding wins, an error report is untouched,
 * and a report that examined at least one thing is untouched.
 */

import { buildErrorReport, buildReport, type Finding, type Report } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { RUN_INTEGRITY_CODE, withRunIntegrity } from '../../src/utils/run-integrity.js';

const GATE = { strict: false };

const EXAMINED: { unit: string; whenZero: string } = {
  unit: 'files',
  whenZero: 'Check the --root points at a project with files to scan.',
};

function finding(code: string, severity: Finding['severity'] = 'error'): Finding {
  return { code, severity, message: `${code} fired` };
}

describe('withRunIntegrity', () => {
  it('adds one RESOURCE_CHECK_BROKEN at error to an ok report that examined nothing, and it becomes findings', () => {
    const report = buildReport({ examined: 0, findings: [], data: null, gate: GATE });

    const published = withRunIntegrity(report, EXAMINED);

    expect(published.status).toBe('findings');
    expect(published.findings).toHaveLength(1);
    expect(published.findings[0]).toMatchObject({ code: RUN_INTEGRITY_CODE, severity: 'error' });
  });

  it('stands down behind an existing RESOURCE_CHECK_BROKEN', () => {
    const report = buildReport({
      examined: 0,
      findings: [finding(RUN_INTEGRITY_CODE, 'error')],
      data: null,
      gate: GATE,
    });

    const published = withRunIntegrity(report, EXAMINED);

    expect(published.findings).toHaveLength(1);
    expect(published).toEqual(report);
  });

  it('stands down behind ANY refusal-kind finding — ard emit ARD_NOT_CONFIGURED at examined 0 carries one refusal, not two', () => {
    const report = buildReport({
      examined: 0,
      findings: [finding('ARD_NOT_CONFIGURED', 'error')],
      data: null,
      gate: GATE,
    });

    const published = withRunIntegrity(report, EXAMINED);

    expect(published.findings).toHaveLength(1);
    expect(published.findings[0]?.code).toBe('ARD_NOT_CONFIGURED');
  });

  it('leaves an error report alone', () => {
    const report = buildErrorReport({
      error: { code: 'INPUT_UNREADABLE', message: 'could not read the input' },
      gate: GATE,
      examined: 0,
      findings: [],
      data: null,
      durationMs: undefined,
    });

    const published = withRunIntegrity(report, EXAMINED);

    expect(published).toEqual(report);
  });

  it('leaves a report that examined something alone', () => {
    const report = buildReport({ examined: 3, findings: [], data: null, gate: GATE });

    const published: Report<null> = withRunIntegrity(report, EXAMINED);

    expect(published).toEqual(report);
  });

  it('names the unit and the remedy in the message', () => {
    const report = buildReport({ examined: 0, findings: [], data: null, gate: GATE });

    const published = withRunIntegrity(report, EXAMINED);

    expect(published.findings[0]?.message).toContain('0 files');
    expect(published.findings[0]?.message).toContain(EXAMINED.whenZero);
  });
});

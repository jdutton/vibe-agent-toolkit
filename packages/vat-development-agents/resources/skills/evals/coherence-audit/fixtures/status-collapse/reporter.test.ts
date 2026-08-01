// The existing suite for reporter.ts. It is GREEN, and it is blind.
import { describe, expect, it } from 'vitest';

import { buildReport, exitCodeFor, renderReport } from './reporter.js';

/** Build a finding. Note what this helper can and cannot express. */
function finding(severity: 'error' | 'warning'): {
  code: string;
  severity: 'error' | 'warning';
  message: string;
} {
  return { code: 'SOME_CODE', severity, message: 'something happened' };
}

describe('buildReport', () => {
  it('reports error when there is an error', () => {
    const report = buildReport([finding('error')]);
    expect(report.status).toBe('error');
  });

  it('reports success when there is nothing', () => {
    expect(buildReport([]).status).toBe('success');
  });

  it('keeps the findings it was given', () => {
    const report = buildReport([finding('warning')]);
    expect(report.findings[0]?.code).toBe('SOME_CODE');
  });
});

describe('renderReport', () => {
  it('renders a heading and the findings', () => {
    const out = renderReport(buildReport([finding('error')]));
    expect(out).toContain('SOME_CODE');
  });
});

describe('exitCodeFor', () => {
  it('is non-zero when the report failed', () => {
    expect(exitCodeFor(buildReport([finding('error')]), false)).not.toBe(0);
  });

  it('is non-zero on an internal error', () => {
    expect(exitCodeFor(buildReport([]), true)).not.toBe(0);
  });
});

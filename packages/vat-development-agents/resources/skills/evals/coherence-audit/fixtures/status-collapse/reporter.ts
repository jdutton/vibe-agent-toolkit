// A findings-reporting lane, in the shape this fixture exists to test.
//
// Everything here compiles and every existing test of it passes. The defects are
// coherence defects: nothing is thrown, nothing crashes, no assertion fails.

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
}

export interface Report {
  status: 'success' | 'error';
  summary: string;
  findings: Finding[];
}

/**
 * Roll findings up into a report.
 *
 * Every finding must be visible to the caller, whatever its severity.
 */
export function buildReport(findings: Finding[]): Report {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;

  return {
    status: errors > 0 ? 'error' : 'success',
    summary: `${errors.toString()} errors, ${warnings.toString()} warnings`,
    findings,
  };
}

/** Render a report for a human reader. */
export function renderReport(report: Report): string {
  if (report.status === 'success') {
    return '✅ All checks passed';
  }
  const lines = report.findings
    .filter((f) => f.severity === 'error' || f.severity === 'warning')
    .map((f) => `[WARNING] ${f.code}: ${f.message}`);
  return [`❌ ${report.summary}`, ...lines].join('\n');
}

/** Exit code for a report. Documented contract: 0 = clean, 1 = findings, 2 = internal error. */
export function exitCodeFor(report: Report, internalError: boolean): number {
  if (internalError || report.status === 'error') {
    return 1;
  }
  return 0;
}

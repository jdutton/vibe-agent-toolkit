/**
 * The one answer to "issues → status", and the counts that keep it honest.
 *
 * This repo had five implementations of this function and three different
 * answers for an info-only issue set, so `vat audit` and the plugin validator
 * could report different statuses for the same plugin. The second vocabulary
 * (`success | warning | error`) is gone; the one left is literal.
 *
 * The contract these tests pin:
 *   - status is `findings` when any published finding exists, `ok` otherwise;
 *     `summary` carries how much of it is actionable.
 *   - `ignore` never counts: it is config-suppressed by the adopter's own
 *     decision, and counting it would resurrect a finding they silenced.
 */

import { describe, expect, it } from 'vitest';

import {
  buildReport,
  countBySeverity,
  resultStatus,
  summarizeIssues,
  type ValidationIssue,
} from '../src/index.js';

function issue(severity: ValidationIssue['severity']): ValidationIssue {
  return { code: 'SKILL_TOO_MANY_FILES', severity, message: `a ${severity}` };
}

describe('resultStatus', () => {
  it('is ok for no issues and findings for an info-only set', () => {
    // The info-only set is the case that had three answers (`warning`,
    // `success`, and a signature that could not see info). The literal word
    // ends the argument: a non-empty list is `findings`, and `summary` says
    // how much of it is actionable.
    expect(resultStatus([])).toBe('ok');
    expect(resultStatus([issue('info'), issue('info')])).toBe('findings');
  });

  it('is findings for any published severity', () => {
    expect(resultStatus([issue('warning')])).toBe('findings');
    expect(resultStatus([issue('error')])).toBe('findings');
  });

  it('is ok when every issue is config-suppressed, agreeing with an all-zero summary', () => {
    // An `ignore` issue is never published (a Finding cannot carry it), so a
    // result holding only suppressed issues says the same thing a report does.
    const issues = [issue('ignore')];
    expect(resultStatus(issues)).toBe('ok');
    expect(countBySeverity(issues)).toEqual({ errors: 0, warnings: 0, info: 0 });
  });

  it('is the derivation buildReport uses', () => {
    const gate = { strict: false };
    expect(buildReport({ examined: 1, findings: [], data: null, gate }).status).toBe(resultStatus([]));
    const findings = [{ code: 'SKILL_TOO_MANY_FILES' as const, severity: 'info' as const, message: 'x' }];
    expect(buildReport({ examined: 1, findings, data: null, gate }).status).toBe(resultStatus(findings));
  });
});

describe('summarizeIssues', () => {
  it('derives status and summary from one issue list, so neither can disagree with it', () => {
    const issues = [issue('error'), issue('info'), issue('ignore')];
    expect(summarizeIssues(issues)).toStrictEqual({
      status: resultStatus(issues),
      summary: countBySeverity(issues),
    });
    expect(summarizeIssues([])).toStrictEqual({ status: 'ok', summary: { errors: 0, warnings: 0, info: 0 } });
  });
});

describe('countBySeverity', () => {
  it('is all zeroes for no issues', () => {
    expect(countBySeverity([])).toEqual({ errors: 0, warnings: 0, info: 0 });
  });

  it('counts each severity independently', () => {
    const counts = countBySeverity([
      issue('error'),
      issue('warning'),
      issue('warning'),
      issue('info'),
      issue('info'),
      issue('info'),
    ]);
    expect(counts).toEqual({ errors: 1, warnings: 2, info: 3 });
  });

  it('excludes `ignore` from every bucket', () => {
    // An allow-listed finding must not reappear as an info count — that would
    // undo the suppression the adopter configured.
    expect(countBySeverity([issue('ignore'), issue('ignore')])).toEqual({
      errors: 0,
      warnings: 0,
      info: 0,
    });
  });

  it('makes an info-only `findings` legible: the count says how much is actionable', () => {
    const issues = [issue('info')];
    expect(resultStatus(issues)).toBe('findings');
    expect(countBySeverity(issues)).toEqual({ errors: 0, warnings: 0, info: 1 });
  });
});

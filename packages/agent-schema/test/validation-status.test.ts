/**
 * The one answer to "issues → status", and the counts that keep it honest.
 *
 * This repo had five implementations of this three-line function and three
 * different answers for an info-only issue set: `calculateValidationStatus`
 * said `warning`, `audit` and `marketplace validate` said `success`, and
 * `corpus/runner`'s `statusFromCounts(errors, warnings)` could not see info at
 * all — its signature made the case unrepresentable. So `vat audit` and the
 * plugin validator could report different statuses for the same plugin.
 *
 * The contract these tests pin:
 *   - status names the worst ACTIONABLE severity: errors ⇒ `error`, warnings ⇒
 *     `warning`, and anything else ⇒ `success`.
 *   - info-only ⇒ `success`, because an informational note is not something the
 *     consumer must act on — but ONLY because the counts travel beside the
 *     status, so `success` never means "there was nothing to see".
 *   - `ignore` never counts: it is config-suppressed by the adopter's own
 *     decision, and counting it would resurrect a finding they silenced.
 */

import { describe, expect, it } from 'vitest';

import {
  calculateValidationStatus,
  countBySeverity,
  type ValidationIssue,
} from '../src/index.js';

function issue(severity: ValidationIssue['severity']): ValidationIssue {
  return { code: 'SKILL_TOO_MANY_FILES', severity, message: `a ${severity}` };
}

describe('calculateValidationStatus', () => {
  it('is success for no issues', () => {
    expect(calculateValidationStatus([])).toBe('success');
  });

  it('is error when any issue is an error, whatever else is present', () => {
    expect(calculateValidationStatus([issue('info'), issue('warning'), issue('error')])).toBe('error');
  });

  it('is warning when the worst actionable severity is a warning', () => {
    expect(calculateValidationStatus([issue('info'), issue('warning')])).toBe('warning');
  });

  it('is success for an info-only set — the divergence this function exists to end', () => {
    // `calculateValidationStatus` used to return `warning` here while `audit`
    // returned `success`, so two lanes disagreed about the same plugin.
    expect(calculateValidationStatus([issue('info'), issue('info')])).toBe('success');
  });

  it('is success when every issue is config-suppressed', () => {
    expect(calculateValidationStatus([issue('ignore')])).toBe('success');
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

  it('makes an info-only `success` legible rather than silent', () => {
    const issues = [issue('info')];
    expect(calculateValidationStatus(issues)).toBe('success');
    expect(countBySeverity(issues).info).toBe(1);
  });
});

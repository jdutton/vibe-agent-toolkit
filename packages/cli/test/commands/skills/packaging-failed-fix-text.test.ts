/**
 * `SKILL_PACKAGING_FAILED` is published by five lanes, and its `fix` tells the
 * operator what to run next. The text was `skills build`'s, so `vat skills
 * package` told its operator to "rebuild" — a verb it is not.
 */

import type { ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import { describe, expect, it } from 'vitest';

import { packagingFailedIssue } from '../../../src/commands/skills/build.js';
import { buildSkillsPackageReport } from '../../../src/commands/skills/package.js';

describe('SKILL_PACKAGING_FAILED - the fix names the verb of the lane that published it', () => {
  it('tells a `vat skills package` operator to re-run that verb, not to rebuild', () => {
    const report = buildSkillsPackageReport({
      validation: { issues: [] } as unknown as ValidationResult,
      data: {} as Parameters<typeof buildSkillsPackageReport>[0]['data'],
      refused: { code: 'SKILL_PACKAGING_FAILED', message: 'files: source does not exist', location: 'skills/a/SKILL.md' },
    });

    const fix = report.findings[0]?.fix;
    expect(fix).toContain('re-run vat skills package');
    expect(fix).not.toContain('rebuild');
  });

  it('carries whatever next step the lane supplies', () => {
    expect(packagingFailedIssue('m', undefined, 're-run vat skill test run').fix).toMatch(/, then re-run vat skill test run\.$/);
  });
});

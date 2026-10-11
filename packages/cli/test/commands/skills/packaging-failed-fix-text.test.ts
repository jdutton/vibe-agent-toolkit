/**
 * `SKILL_PACKAGING_FAILED` is published by five lanes, and its `fix` tells the
 * operator what to run next. The text was `skills build`'s, so `vat skills
 * package` told its operator to "rebuild" — a verb it is not.
 */

import { asPackagerRefusal, type ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import { fsFaultRefusal } from '@vibe-agent-toolkit/schema';
import { classifyFsFault, type FsFaultError } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { packagingFailedIssue } from '../../../src/commands/skills/build.js';
import { buildSkillsPackageReport } from '../../../src/commands/skills/package.js';

describe('SKILL_PACKAGING_FAILED - the fix names the verb of the lane that published it', () => {
  it('tells a `vat skills package` operator to re-run that verb, not to rebuild', () => {
    const report = buildSkillsPackageReport({
      validation: { issues: [] } as unknown as ValidationResult,
      data: {} as Parameters<typeof buildSkillsPackageReport>[0]['data'],
      refused: { code: 'SKILL_PACKAGING_FAILED', message: 'files: source does not exist', location: 'skills/a/SKILL.md', thrown: undefined },
      runFindings: [],
    });

    const fix = report.findings[0]?.fix;
    expect(fix).toContain('re-run vat skills package');
    expect(fix).not.toContain('rebuild');
  });

  it('carries whatever next step the lane supplies', () => {
    expect(packagingFailedIssue('m', undefined, 're-run vat skill test run', undefined).fix).toMatch(/, then re-run vat skill test run\.$/);
  });
});

describe('SKILL_PACKAGING_FAILED - a finding built from a classified fault carries the table\'s remedy', () => {
  const fault = classifyFsFault(Object.assign(new Error('EACCES: denied'), { code: 'EACCES', path: '/p/a.md' }), {
    side: 'source', origin: 'content', action: 'read linked file a.md',
  }) as FsFaultError;
  const { remedy } = fsFaultRefusal('source', 'refused', 'content');

  it.each([
    ['the fault itself', fault],
    ['the packager refusal wrapping it', asPackagerRefusal(fault)],
  ] as const)('appends the remedy once, from %s', (_what, thrown) => {
    const { message } = packagingFailedIssue(fault.message, undefined, 'rebuild', thrown);
    expect(message).toBe(`${fault.message}. ${remedy}`);
  });

  it('leaves a coded content refusal\'s message as it is', () => {
    expect(packagingFailedIssue('files: source does not exist', undefined, 'rebuild', new Error('x')).message).toBe('files: source does not exist');
  });
});

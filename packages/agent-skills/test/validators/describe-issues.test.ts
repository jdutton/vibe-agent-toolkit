import { countBySeverity, resultStatus, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { describeIssues } from '../../src/index.js';

function issue(severity: ValidationIssue['severity']): ValidationIssue {
  return { code: 'SKILL_TOO_MANY_FILES', severity, message: `a ${severity}` };
}

describe('describeIssues', () => {
  it('derives status, summary and the sentence from ONE issue list', () => {
    const issues = [issue('error'), issue('warning'), issue('info'), issue('info')];

    expect(describeIssues(issues, 'agent-skill')).toStrictEqual({
      status: resultStatus(issues),
      summary: countBySeverity(issues),
      description: '1 errors, 1 warnings, 2 info',
    });
  });

  it('says the type\'s clean sentence only when there is nothing to count', () => {
    expect(describeIssues([], 'claude-plugin').description).toBe('Valid plugin');
    expect(describeIssues([], 'marketplace').description).toBe('Valid marketplace');
    expect(describeIssues([], 'registry').description).toBe('Valid registry');
    // A type with no clean sentence reads as its zero counts.
    expect(describeIssues([], 'agent-skill').description).toBe('0 errors, 0 warnings, 0 info');
    // A clean sentence over findings would contradict them: the counts win.
    expect(describeIssues([issue('warning')], 'claude-plugin').description).toBe('0 errors, 1 warnings, 0 info');
  });

  it('prefixes a halted lane\'s reason to the counts, never replacing them', () => {
    // A lane that stops early (no manifest, manifest not JSON) says why — and
    // still counts every finding it had gathered before it stopped.
    const issues = [issue('error'), issue('warning')];
    expect(describeIssues(issues, 'claude-plugin', 'Plugin manifest missing')).toStrictEqual({
      status: resultStatus(issues),
      summary: countBySeverity(issues),
      description: 'Plugin manifest missing: 1 errors, 1 warnings, 0 info',
    });
  });
});

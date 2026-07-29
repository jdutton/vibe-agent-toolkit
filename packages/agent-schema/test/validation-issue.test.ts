import { describe, expect, it } from 'vitest';

import { CODE_REGISTRY } from '../src/validation-codes.js';
import { createRegistryIssue, ValidationIssueSchema } from '../src/validation-issue.js';

/** A minimal valid issue; each case below varies exactly one anchor field. */
function issueWith(extras: Record<string, unknown>): Record<string, unknown> {
  return { code: 'LINK_OUTSIDE_PROJECT', severity: 'warning', message: 'msg', ...extras };
}

describe('ValidationIssueSchema location contract', () => {
  it.each([
    ['POSIX absolute', '/Users/dev/skills/foo/SKILL.md'],
    ['Windows drive absolute', 'C:/Users/dev/skills/foo/SKILL.md'],
    ['Windows backslash absolute', String.raw`C:\Users\dev\SKILL.md`],
    ['relative with backslashes', String.raw`skills\foo\SKILL.md`],
  ])('rejects a %s location', (_label, location) => {
    // `location` was a bare `z.string()`, which is how 235 absolute paths
    // shipped unnoticed. A Windows-absolute path must be rejected on POSIX CI
    // too, hence the host-independent check.
    expect(ValidationIssueSchema.safeParse(issueWith({ location })).success).toBe(false);
  });

  it('accepts a project-relative POSIX location alongside line and field', () => {
    const parsed = ValidationIssueSchema.safeParse(
      issueWith({ location: 'skills/foo/SKILL.md', line: 24, field: 'frontmatter.description' }),
    );
    expect(parsed.success).toBe(true);
  });

  it('accepts an issue with no location at all', () => {
    expect(ValidationIssueSchema.safeParse(issueWith({ field: 'validation.allow.X' })).success).toBe(true);
  });
});

describe('createRegistryIssue', () => {
  it('fills severity/fix/reference from the registry entry', () => {
    const issue = createRegistryIssue('SKILL_TIME_SENSITIVE_CONTENT', 'msg');
    const entry = CODE_REGISTRY.SKILL_TIME_SENSITIVE_CONTENT;

    expect(issue.code).toBe('SKILL_TIME_SENSITIVE_CONTENT');
    expect(issue.message).toBe('msg');
    expect(issue.severity).toBe(entry.defaultSeverity);
    expect(issue.fix).toBe(entry.fix);
    expect(issue.reference).toBe(entry.reference);
  });

  it('merges extras over the base issue', () => {
    const issue = createRegistryIssue('LINK_OUTSIDE_PROJECT', 'broken', {
      location: 'docs/skill.md',
      line: 42,
    });

    expect(issue.location).toBe('docs/skill.md');
    expect(issue.line).toBe(42);
    // Registry-derived fields remain present alongside extras.
    expect(issue.severity).toBe(CODE_REGISTRY.LINK_OUTSIDE_PROJECT.defaultSeverity);
    expect(issue.fix).toBe(CODE_REGISTRY.LINK_OUTSIDE_PROJECT.fix);
  });
});

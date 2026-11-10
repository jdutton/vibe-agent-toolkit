import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CODE_REGISTRY } from '../src/validation-codes.js';
import { anchoredAt, createRegistryIssue, isProjectLocation, projectLocationOf, ValidationIssueSchema } from '../src/validation-issue.js';

/** A minimal valid issue; each case below varies exactly one anchor field. */
function issueWith(extras: Record<string, unknown>): Record<string, unknown> {
  return { code: 'LINK_OUTSIDE_PROJECT', severity: 'warning', message: 'msg', ...extras };
}

describe('ValidationIssueSchema location contract', () => {
  it.each([
    ['POSIX absolute', '/Users/dev/skills/foo/SKILL.md'],
    ['Windows drive absolute', 'C:/Users/dev/skills/foo/SKILL.md'],
    ['Windows backslash absolute', String.raw`C:\Users\dev\SKILL.md`],
  ])('rejects a %s location', (_label, location) => {
    // `location` was a bare `z.string()`, which is how 235 absolute paths
    // shipped unnoticed. A Windows-absolute path must be rejected on POSIX CI
    // too, hence the host-independent check.
    expect(ValidationIssueSchema.safeParse(issueWith({ location })).success).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['drive-relative', 'C:foo/SKILL.md'],
    ['climbing', '../outside/SKILL.md'],
    ['climbing after a descent', 'docs/../../outside.md'],
    ['bare parent', '..'],
    ['root-itself', '.'],
    ['root-through-a-descent', 'docs/..'],
    ['backslash-led (on every host)', String.raw`\docs\a.md`],
    ['UNC (on every host)', String.raw`\\host\share\a.md`],
    ['forward-slashed UNC', '//host/share/a.md'],
  ])('rejects a %s location', (_label, location) => {
    expect(ValidationIssueSchema.safeParse(issueWith({ location })).success).toBe(false);
    expect(isProjectLocation(location)).toBe(false);
  });

  it.each([
    ['nested', 'skills/foo/SKILL.md'],
    ['dot-led name', '..hidden/x.md'],
  ])('accepts a %s location through the one predicate', (_label, location) => {
    expect(ValidationIssueSchema.safeParse(issueWith({ location })).success).toBe(true);
    expect(isProjectLocation(location)).toBe(true);
  });

  it.each([
    ['a plain location', 'docs/a.md', 'docs/a.md'],
    ['a leading ./', './docs/a.md', 'docs/a.md'],
    ['a repeated leading ./', '././docs/a.md', 'docs/a.md'],
    ['a descent that rises back inside', 'docs/../README.md', 'README.md'],
    ['a ./ segment in the middle', 'docs/./a.md', 'docs/a.md'],
  ])('projectLocationOf emits %s as the location in its normalised form', (_label, value, location) => {
    expect(projectLocationOf(value)).toBe(location);
    expect(ValidationIssueSchema.safeParse(issueWith({ location: projectLocationOf(value) })).success).toBe(true);
  });

  // A location is PUBLISHED normalised: a spelling projectLocationOf would rewrite is refused at the schema.
  it.each([
    ['a leading ./', './docs/a.md'],
    ['a descent that rises back inside', 'docs/../a.md'],
    ['a ./ segment in the middle', 'docs/./a.md'],
    ['a doubled separator', 'docs//a.md'],
  ])('rejects a location not in its normalised form: %s', (_label, location) => {
    expect(ValidationIssueSchema.safeParse(issueWith({ location })).success).toBe(false);
  });

  it('anchoredAt keeps a location that can be one, and otherwise names the path in the message', () => {
    expect(anchoredAt('Broken link', './docs/a.md')).toStrictEqual({ message: 'Broken link', location: 'docs/a.md' });
    expect(anchoredAt('Broken link', '../shared-docs/a.md')).toStrictEqual({ message: 'Broken link (../shared-docs/a.md)' });
  });

  it('createRegistryIssue omits a location that cannot be one and names its path in the message', () => {
    const issue = createRegistryIssue('LINK_OUTSIDE_SKILL_DIR', 'Link points outside', { location: '../outside/SKILL.md', line: 3 });

    expect(issue.location).toBeUndefined();
    expect(issue.message).toBe('Link points outside (../outside/SKILL.md)');
    expect(issue.line).toBe(3);
    expect(ValidationIssueSchema.safeParse(issue).success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['bare ./', './'],
    ['the root through a descent', 'docs/..'],
    ['climbing', './../x.md'],
    ['absolute', '/abs/x.md'],
    ['a leading backslash', String.raw`\abs\x.md`],
  ])(
    'projectLocationOf has no location for %s',
    (_label, value) => {
      expect(projectLocationOf(value)).toBeUndefined();
    },
  );

  // Gated: a backslash is a separator only on win32; on POSIX `skills\foo\SKILL.md` is one legal filename.
  it.skipIf(path.sep !== '\\')('rejects a backslashed relative location on win32', () => {
    expect(ValidationIssueSchema.safeParse(issueWith({ location: String.raw`skills\foo\SKILL.md` })).success).toBe(false);
  });

  // Gated: on win32 the backslash is a separator, and the case above is the contract there.
  it.skipIf(path.sep === '\\')('accepts a POSIX filename that contains a backslash', () => {
    expect(ValidationIssueSchema.safeParse(issueWith({ location: String.raw`.claude/rules/a\b.md` })).success).toBe(true);
  });

  it('accepts a project-relative POSIX location alongside line and field', () => {
    const parsed = ValidationIssueSchema.safeParse(
      issueWith({ location: 'skills/foo/SKILL.md', line: 24, field: 'frontmatter.description' }),
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects a column with no line: a column is within a line', () => {
    expect(ValidationIssueSchema.safeParse(issueWith({ location: 'docs/a.md', column: 3 })).success).toBe(false);
    expect(ValidationIssueSchema.safeParse(issueWith({ location: 'docs/a.md', line: 2, column: 3 })).success).toBe(true);
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

/**
 * `column` has ONE home: the issue itself. A published `Finding` inherits it
 * rather than re-adding it, so a lane that knows a column carries it on the
 * issue it builds instead of only on the document it publishes.
 */
describe('ValidationIssueSchema column', () => {
  it('accepts a 1-based column beside its line', () => {
    expect(ValidationIssueSchema.safeParse(issueWith({ location: 'a.md', line: 3, column: 5 })).success).toBe(true);
  });

  it.each([0, -1, 1.5])('refuses column %s', (column) => {
    expect(ValidationIssueSchema.safeParse(issueWith({ line: 3, column })).success).toBe(false);
  });

  it('is an extra createRegistryIssue carries', () => {
    const issue = createRegistryIssue('LINK_OUTSIDE_PROJECT', 'broken', { location: 'a.md', line: 3, column: 5 });

    expect(issue.column).toBe(5);
  });
});

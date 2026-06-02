import { describe, expect, it } from 'vitest';

import { CODE_REGISTRY } from '../src/validation-codes.js';
import { createRegistryIssue } from '../src/validation-issue.js';

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

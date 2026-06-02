import { describe, it, expect } from 'vitest';

import { applyAllowFilter } from '../src/validation-framework.js';
import type { ValidationIssue } from '../src/validation-issue.js';

const LINK_DROPPED = 'LINK_DROPPED_BY_DEPTH';
const DOCS_FOO = 'docs/foo.md';

const issue = (code: string, location: string): ValidationIssue => ({
  severity: 'error', code: code as ValidationIssue['code'], message: `${code} on ${location}`, location,
});

describe('applyAllowFilter', () => {
  it('emits all issues when no allow entries provided', () => {
    const issues = [issue(LINK_DROPPED, DOCS_FOO)];
    const result = applyAllowFilter(issues, {});
    expect(result.emitted).toHaveLength(1);
    expect(result.allowed).toHaveLength(0);
  });

  it('allows issues whose (code, location) matches an entry', () => {
    const issues = [issue(LINK_DROPPED, DOCS_FOO)];
    const result = applyAllowFilter(issues, {
      allow: {
        [LINK_DROPPED]: [{ paths: ['docs/**'], reason: 'intentional' }],
      },
    });
    expect(result.emitted).toHaveLength(0);
    expect(result.allowed).toHaveLength(1);
    const [first] = result.allowed;
    expect(first?.reason).toBe('intentional');
  });

  it('only suppresses the specific code (cross-code instances still fire)', () => {
    const issues = [
      issue(LINK_DROPPED, DOCS_FOO),
      issue('LINK_TO_GITIGNORED_FILE', DOCS_FOO),
    ];
    const result = applyAllowFilter(issues, {
      allow: { [LINK_DROPPED]: [{ paths: ['docs/**'], reason: 'x' }] },
    });
    expect(result.emitted.map(i => i.code)).toEqual(['LINK_TO_GITIGNORED_FILE']);
  });

  it('flags allow entries that matched nothing as unused', () => {
    const issues: ValidationIssue[] = [];
    const result = applyAllowFilter(issues, {
      allow: { [LINK_DROPPED]: [{ paths: ['docs/nope.md'], reason: 'stale' }] },
    });
    expect(result.unused).toHaveLength(1);
    const [first] = result.unused;
    expect(first?.reason).toBe('stale');
  });

  // Regression guard: picomatch defaults exclude dotfile segments, so
  // `**/*` silently fails to match any path traversing `.claude/`,
  // `.worktrees/`, `.config/`, etc. — causing allow entries to never apply
  // and capability suppressions to leak. The matcher must enable dot.
  it('matches paths containing dotfile segments (e.g., .claude/, .worktrees/)', () => {
    const dotfilePaths = [
      '.claude/skills/foo/SKILL.md',
      '.worktrees/wt1/packages/x/SKILL.md',
      'project/.config/agents/y.md',
    ];
    for (const location of dotfilePaths) {
      const issues = [issue(LINK_DROPPED, location)];
      const result = applyAllowFilter(issues, {
        allow: { [LINK_DROPPED]: [{ paths: ['**/*'], reason: 'broad allow' }] },
      });
      expect(result.allowed, `expected '**/*' to match '${location}'`).toHaveLength(1);
      expect(result.emitted).toHaveLength(0);
    }
  });

  it('flags allow entries with past expires as expired', () => {
    const issues = [issue(LINK_DROPPED, DOCS_FOO)];
    const result = applyAllowFilter(issues, {
      allow: {
        [LINK_DROPPED]: [{ paths: [DOCS_FOO], reason: 'temp', expires: '2020-01-01' }],
      },
    });
    expect(result.emitted).toHaveLength(0); // allow still applies
    expect(result.allowed).toHaveLength(1);
    expect(result.expired).toHaveLength(1);
    const [first] = result.expired;
    expect(first?.reason).toBe('temp');
  });
});

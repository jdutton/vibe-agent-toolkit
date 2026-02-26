/**
 * Unit tests for settings-conflict-analyzer.ts
 */

import { describe, expect, it } from 'vitest';

import { analyzeRuleConflicts } from '../src/settings/settings-conflict-analyzer.js';
import type { EffectiveSettings } from '../src/settings/settings-merger.js';

// ---------------------------------------------------------------------------
// String constants (avoids sonarjs/no-duplicate-string)
// ---------------------------------------------------------------------------

const USER_FILE = '/Users/test/.claude/settings.json';
const PROJECT_FILE = '/project/.claude/settings.json';
const PROJECT_LOCAL_FILE = '/project/.claude/settings.local.json';

const KIND_SHADOWED_BY_DENY = 'shadowed-by-deny';
const KIND_SHADOWED_BY_ASK = 'shadowed-by-ask';
const KIND_REDUNDANT = 'redundant';

const BASH_GIT_STAR = 'Bash(git *)';
const BASH_GIT_STATUS = 'Bash(git status)';
const BASH_GIT_PUSH = 'Bash(git push)';
const BASH_GIT_PUSH_STAR = 'Bash(git push *)';
const BASH_STAR = 'Bash(*)';
const BASH = 'Bash';
const BASH_NPM_RUN_STAR = 'Bash(npm run *)';
const BASH_NPM_RUN_LINT = 'Bash(npm run lint)';
const BASH_RM_RF = 'Bash(rm -rf)';
const BASH_RM_STAR = 'Bash(rm *)';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(
  rule: string,
  file = USER_FILE,
  level: 'user' | 'project' | 'project-local' = 'user'
) {
  return { rule, provenance: { file, level } };
}

function makeEffective(
  deny: string[] = [],
  ask: string[] = [],
  allow: string[] = [],
  denyFile = USER_FILE,
  askFile = PROJECT_FILE,
  allowFile = PROJECT_LOCAL_FILE
): EffectiveSettings {
  return {
    permissions: {
      deny: deny.map(r => makeRule(r, denyFile, 'user')),
      ask: ask.map(r => makeRule(r, askFile, 'project')),
      allow: allow.map(r => makeRule(r, allowFile, 'project-local')),
    },
  };
}

/** Assert exactly one conflict with the given shape. */
function assertSingleConflict(
  effective: EffectiveSettings,
  expected: { kind: string; rule: string; shadowedBy: string }
) {
  const conflicts = analyzeRuleConflicts(effective);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toMatchObject({
    kind: expected.kind,
    rule: { rule: expected.rule },
    shadowedBy: { rule: expected.shadowedBy },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('analyzeRuleConflicts', () => {
  it('returns empty array when there are no rules', () => {
    const effective = makeEffective();
    expect(analyzeRuleConflicts(effective)).toEqual([]);
  });

  it('returns empty array when rules have no conflicts', () => {
    const effective = makeEffective([BASH_RM_STAR], [BASH_GIT_STAR], [BASH_NPM_RUN_STAR]);
    expect(analyzeRuleConflicts(effective)).toEqual([]);
  });

  it('detects ask rule shadowed by deny rule (exact match)', () => {
    assertSingleConflict(makeEffective([BASH_GIT_PUSH], [BASH_GIT_PUSH]), {
      kind: KIND_SHADOWED_BY_DENY, rule: BASH_GIT_PUSH, shadowedBy: BASH_GIT_PUSH,
    });
  });

  it('detects ask rule shadowed by a broader deny wildcard', () => {
    assertSingleConflict(makeEffective([BASH_GIT_STAR], [BASH_GIT_PUSH]), {
      kind: KIND_SHADOWED_BY_DENY, rule: BASH_GIT_PUSH, shadowedBy: BASH_GIT_STAR,
    });
  });

  it('does not flag ask rule when deny rule is narrower', () => {
    // deny Bash(git push) does NOT subsume ask Bash(git *)
    const effective = makeEffective([BASH_GIT_PUSH], [BASH_GIT_STAR]);
    expect(analyzeRuleConflicts(effective)).toEqual([]);
  });

  it('detects allow rule shadowed by deny rule', () => {
    assertSingleConflict(makeEffective([BASH_STAR], [], [BASH_NPM_RUN_LINT]), {
      kind: KIND_SHADOWED_BY_DENY, rule: BASH_NPM_RUN_LINT, shadowedBy: BASH_STAR,
    });
  });

  it('detects allow rule shadowed by ask rule', () => {
    assertSingleConflict(makeEffective([], [BASH_GIT_STAR], [BASH_GIT_STATUS]), {
      kind: KIND_SHADOWED_BY_ASK, rule: BASH_GIT_STATUS, shadowedBy: BASH_GIT_STAR,
    });
  });

  it('reports shadowed-by-deny (not shadowed-by-ask) when allow is shadowed by both', () => {
    // deny Bash(*) and ask Bash(git *) both subsume allow Bash(git status)
    const effective = makeEffective([BASH_STAR], [BASH_GIT_STAR], [BASH_GIT_STATUS]);
    const conflicts = analyzeRuleConflicts(effective);
    const forGitStatus = conflicts.filter(c => c.rule.rule === BASH_GIT_STATUS);
    expect(forGitStatus).toHaveLength(1);
    expect(forGitStatus[0]?.kind).toBe(KIND_SHADOWED_BY_DENY);
  });

  it('detects redundant exact duplicates in deny bucket', () => {
    const effective: EffectiveSettings = {
      permissions: {
        deny: [
          makeRule(BASH_RM_RF, USER_FILE, 'user'),
          makeRule(BASH_RM_RF, PROJECT_FILE, 'project'),
        ],
        ask: [],
        allow: [],
      },
    };
    const conflicts = analyzeRuleConflicts(effective);
    // Each rule is subsumed by the other → 2 redundant conflicts
    expect(conflicts.filter(c => c.kind === KIND_REDUNDANT)).toHaveLength(2);
  });

  it('detects redundant rule in allow bucket when broader sibling exists', () => {
    const effective: EffectiveSettings = {
      permissions: {
        deny: [],
        ask: [],
        allow: [
          makeRule(BASH_NPM_RUN_STAR, USER_FILE, 'user'),
          makeRule(BASH_NPM_RUN_LINT, PROJECT_FILE, 'project'),
        ],
      },
    };
    const conflicts = analyzeRuleConflicts(effective);
    // Bash(npm run lint) is redundant — subsumed by Bash(npm run *)
    const redundant = conflicts.filter(c => c.kind === KIND_REDUNDANT);
    expect(redundant).toHaveLength(1);
    expect(redundant[0]).toMatchObject({
      kind: KIND_REDUNDANT,
      rule: { rule: BASH_NPM_RUN_LINT },
      shadowedBy: { rule: BASH_NPM_RUN_STAR },
    });
  });

  it('detects redundant narrower wildcard within allow bucket', () => {
    const effective: EffectiveSettings = {
      permissions: {
        deny: [],
        ask: [],
        allow: [
          makeRule(BASH_STAR, USER_FILE, 'user'),
          makeRule(BASH_GIT_PUSH_STAR, PROJECT_FILE, 'project'),
        ],
      },
    };
    const conflicts = analyzeRuleConflicts(effective);
    const redundant = conflicts.filter(c => c.kind === KIND_REDUNDANT);
    expect(redundant).toHaveLength(1);
    expect(redundant[0]).toMatchObject({
      kind: KIND_REDUNDANT,
      rule: { rule: BASH_GIT_PUSH_STAR },
      shadowedBy: { rule: BASH_STAR },
    });
  });

  it('does not flag redundant across different buckets', () => {
    // deny Bash(*) and allow Bash(git) — cross-bucket, not redundant
    const effective = makeEffective([BASH_STAR], [], [BASH_GIT_STATUS]);
    const conflicts = analyzeRuleConflicts(effective);
    expect(conflicts.every(c => c.kind !== KIND_REDUNDANT)).toBe(true);
  });

  it('rules for different tools never conflict', () => {
    const effective = makeEffective([BASH_STAR], ['Edit'], ['Read']);
    // Bash deny does not subsume Edit ask or Read allow
    const conflicts = analyzeRuleConflicts(effective);
    expect(conflicts).toHaveLength(0);
  });

  it('bare tool name deny subsumes specific ask for same tool', () => {
    // deny "Bash" subsumes ask "Bash(git *)"
    assertSingleConflict(makeEffective([BASH], [BASH_GIT_STAR]), {
      kind: KIND_SHADOWED_BY_DENY, rule: BASH_GIT_STAR, shadowedBy: BASH,
    });
  });

  it('preserves provenance on detected conflicts', () => {
    const effective = makeEffective([BASH_GIT_STAR], [BASH_GIT_STATUS]);
    const conflicts = analyzeRuleConflicts(effective);
    expect(conflicts[0]?.rule.provenance.file).toBe(PROJECT_FILE);
    expect(conflicts[0]?.rule.provenance.level).toBe('project');
    expect(conflicts[0]?.shadowedBy.provenance.file).toBe(USER_FILE);
    expect(conflicts[0]?.shadowedBy.provenance.level).toBe('user');
  });
});

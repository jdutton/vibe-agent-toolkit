/**
 * Unit tests for permission-matcher.ts
 * Verifies our reimplementation of Claude Code's permission matching logic.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyBashRule,
  isSubsumedBy,
  matchesBashRule,
  matchesPermissionRule,
  parseBashRuleContent,
  parsePermissionRule,
} from '../src/settings/permission-matcher.js';

// String constants to avoid sonarjs/no-duplicate-string
const EXACT = 'exact';
const WILDCARD = 'wildcard';
const PREFIX = 'prefix';
const NPM_RUN_LINT = 'npm run lint';
const NPM_RUN_STAR = 'npm run *';
const NPM_RUN_PREFIX = 'npm run:*';
const GIT_STATUS = 'git status';
const GIT_STAR_CONTENT = 'git *';
const GIT_STAR = 'Bash(git *)';
const GIT_PUSH_STAR = 'Bash(git push *)';
const BASH_NPM_RUN_LINT = 'Bash(npm run lint)';
const BASH_NPM_RUN_STAR = 'Bash(npm run *)';
const BASH_NPM_RUN_PREFIX = 'Bash(npm run:*)';
const GIT_PUSH_ORIGIN_MAIN = 'git push origin main';

describe('parsePermissionRule', () => {
  it('parses bare tool name', () => {
    const result = parsePermissionRule('Edit');
    expect(result).toEqual({ toolName: 'Edit', content: undefined });
  });

  it('parses tool with content', () => {
    const result = parsePermissionRule(BASH_NPM_RUN_STAR);
    expect(result).toEqual({ toolName: 'Bash', content: NPM_RUN_STAR });
  });

  it('parses tool with path content', () => {
    const result = parsePermissionRule('Read(./.env)');
    expect(result).toEqual({ toolName: 'Read', content: './.env' });
  });

  it('normalises whitespace in rule', () => {
    const result = parsePermissionRule('Bash(  npm  run  *  )');
    expect(result).toEqual({ toolName: 'Bash', content: NPM_RUN_STAR });
  });
});

describe('classifyBashRule', () => {
  it('classifies exact rules', () => {
    expect(classifyBashRule(NPM_RUN_LINT)).toBe(EXACT);
    expect(classifyBashRule(GIT_STATUS)).toBe(EXACT);
  });

  it('classifies wildcard rules', () => {
    expect(classifyBashRule(NPM_RUN_STAR)).toBe(WILDCARD);
    expect(classifyBashRule(GIT_STAR_CONTENT)).toBe(WILDCARD);
    expect(classifyBashRule('*')).toBe(WILDCARD);
  });

  it('classifies legacy prefix rules', () => {
    expect(classifyBashRule(NPM_RUN_PREFIX)).toBe(PREFIX);
    expect(classifyBashRule('git:*')).toBe(PREFIX);
  });

  it('does not classify escaped * as wildcard', () => {
    expect(classifyBashRule(String.raw`git commit -m "fix \*"`)).toBe(EXACT);
  });
});

describe('matchesBashRule', () => {
  it('bare Bash matches any command', () => {
    expect(matchesBashRule(NPM_RUN_LINT, 'Bash')).toBe(true);
    expect(matchesBashRule(GIT_PUSH_ORIGIN_MAIN, 'Bash')).toBe(true);
  });

  it('Bash(*) matches any command', () => {
    expect(matchesBashRule(NPM_RUN_LINT, 'Bash(*)')).toBe(true);
    expect(matchesBashRule(GIT_PUSH_ORIGIN_MAIN, 'Bash(*)')).toBe(true);
  });

  it('exact rule matches same command', () => {
    expect(matchesBashRule(NPM_RUN_LINT, BASH_NPM_RUN_LINT)).toBe(true);
    expect(matchesBashRule('npm run test', BASH_NPM_RUN_LINT)).toBe(false);
  });

  it('wildcard * matches spaces (git * matches git push origin main)', () => {
    expect(matchesBashRule(GIT_PUSH_ORIGIN_MAIN, GIT_STAR)).toBe(true);
    expect(matchesBashRule(GIT_STATUS, GIT_STAR)).toBe(true);
    expect(matchesBashRule('git', GIT_STAR)).toBe(false); // no space after git
  });

  it('wildcard anchoring: Bash(ls *) does NOT match lsof', () => {
    expect(matchesBashRule('ls -la', 'Bash(ls *)')).toBe(true);
    expect(matchesBashRule('lsof', 'Bash(ls *)')).toBe(false);
  });

  it('non-Bash rule does not match', () => {
    expect(matchesBashRule(NPM_RUN_LINT, 'Edit')).toBe(false);
    expect(matchesBashRule(NPM_RUN_LINT, 'Read(./.env)')).toBe(false);
  });

  it('normalises whitespace before matching', () => {
    expect(matchesBashRule('npm  run  lint', BASH_NPM_RUN_LINT)).toBe(true);
  });

  it('prefix rule matches base and base + args', () => {
    expect(matchesBashRule('npm run', BASH_NPM_RUN_PREFIX)).toBe(true);
    expect(matchesBashRule(NPM_RUN_LINT, BASH_NPM_RUN_PREFIX)).toBe(true);
    expect(matchesBashRule('xargs npm run', BASH_NPM_RUN_PREFIX)).toBe(true);
    expect(matchesBashRule('xargs npm run lint', BASH_NPM_RUN_PREFIX)).toBe(true);
    expect(matchesBashRule('npm install', BASH_NPM_RUN_PREFIX)).toBe(false);
  });
});

describe('matchesPermissionRule', () => {
  it('bare Edit matches any Edit call', () => {
    expect(matchesPermissionRule('Edit', '/some/file.ts', 'Edit')).toBe(true);
    expect(matchesPermissionRule('Edit', '/any/path', 'Edit')).toBe(true);
  });

  it('wrong tool name does not match', () => {
    expect(matchesPermissionRule('Bash', NPM_RUN_LINT, 'Edit')).toBe(false);
    expect(matchesPermissionRule('Edit', '/file', 'Bash')).toBe(false);
  });

  it('tool names are case-sensitive', () => {
    expect(matchesPermissionRule('bash', NPM_RUN_LINT, BASH_NPM_RUN_STAR)).toBe(false);
    expect(matchesPermissionRule('Bash', NPM_RUN_LINT, BASH_NPM_RUN_STAR)).toBe(true);
  });
});

describe('isSubsumedBy', () => {
  it('identical rules subsume each other', () => {
    expect(isSubsumedBy(GIT_PUSH_STAR, GIT_PUSH_STAR)).toBe(true);
  });

  it('broad wildcard subsumes narrow wildcard', () => {
    expect(isSubsumedBy(GIT_PUSH_STAR, GIT_STAR)).toBe(true);
    expect(isSubsumedBy(GIT_STAR, 'Bash(*)')).toBe(true);
  });

  it('does not subsume in wrong direction', () => {
    expect(isSubsumedBy(GIT_STAR, GIT_PUSH_STAR)).toBe(false);
  });

  it('bare tool name subsumes everything for that tool', () => {
    expect(isSubsumedBy(GIT_STAR, 'Bash')).toBe(true);
    expect(isSubsumedBy('Edit', 'Edit')).toBe(true);
  });

  it('different tools never subsume', () => {
    expect(isSubsumedBy('Bash(*)', 'Edit')).toBe(false);
  });

  it('exact broad subsumes exact narrow with same content', () => {
    expect(isSubsumedBy(BASH_NPM_RUN_LINT, BASH_NPM_RUN_LINT)).toBe(true);
    expect(isSubsumedBy(BASH_NPM_RUN_LINT, 'Bash(npm run test)')).toBe(false);
  });
});

describe('parseBashRuleContent', () => {
  it('builds regex for wildcard rules', () => {
    const parsed = parseBashRuleContent(NPM_RUN_STAR);
    expect(parsed.type).toBe(WILDCARD);
    expect(parsed.regex).toBeDefined();
    expect(parsed.regex?.test(NPM_RUN_LINT)).toBe(true);
    expect(parsed.regex?.test('npm run build')).toBe(true);
    expect(parsed.regex?.test('npm install')).toBe(false);
  });

  it('strips :* from prefix rules', () => {
    const parsed = parseBashRuleContent(NPM_RUN_PREFIX);
    expect(parsed.type).toBe(PREFIX);
    expect(parsed.content).toBe('npm run');
  });

  it('returns exact type for literal commands', () => {
    const parsed = parseBashRuleContent(GIT_STATUS);
    expect(parsed.type).toBe(EXACT);
    expect(parsed.content).toBe(GIT_STATUS);
  });
});

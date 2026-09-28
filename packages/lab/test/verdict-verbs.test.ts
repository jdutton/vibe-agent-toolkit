/**
 * The verb matrix's argv and the APFS clone plan — both pure.
 */

import { describe, expect, it } from 'vitest';

import { type CloneSource, planApfsClone } from '../src/facets/verdict/clone.js';
import { buildVerbInvocations, verdictVerb, type VerbSubject } from '../src/facets/verdict/verbs.js';

import { PROBE_VERSION } from './command-probe.js';

const SUBJECT: VerbSubject = {
  path: '/work/tree',
  contextPath: 'docs/guide.md',
  queries: [
    { file: 'sql/a.sql', sql: 'SELECT 1' },
    { file: 'sql/b.sql', sql: 'SELECT 2' },
  ],
};

describe('verdict verb matrix', () => {
  it.each([
    ['audit', [['audit', '/work/tree']]],
    ['skills-validate', [['skills', 'validate', '/work/tree', '--verbose']]],
    ['resources-validate', [['resources', 'validate', '/work/tree', '--format', 'json']]],
    ['resources-check', [['resources', 'check', '/work/tree', '--format', 'json']]],
    ['context-all', [['claude', 'context', '--all', '--format', 'json']]],
    ['context-path', [['claude', 'context', 'docs/guide.md', '--format', 'json']]],
  ] as const)('spells %s', (name, argv) => {
    expect(verdictVerb(name).args(SUBJECT, PROBE_VERSION).map((invocation) => invocation.argv)).toEqual(argv);
  });

  it('runs resources-query once per SQL file, each row named by its file as written', () => {
    expect(verdictVerb('resources-query').args(SUBJECT, PROBE_VERSION)).toEqual([
      { name: 'resources-query:sql/a.sql', argv: ['resources', 'query', 'SELECT 1', '/work/tree', '--format', 'json'] },
      { name: 'resources-query:sql/b.sql', argv: ['resources', 'query', 'SELECT 2', '/work/tree', '--format', 'json'] },
    ]);
  });

  it('spells the build verbs, build first', () => {
    expect(buildVerbInvocations(SUBJECT, PROBE_VERSION)).toEqual([
      { name: 'build', argv: ['build'] },
      { name: 'verify', argv: ['verify'] },
      { name: 'marketplace-publish-dry-run', argv: ['claude', 'marketplace', 'publish', '--dry-run'] },
    ]);
  });
});

describe('planApfsClone', () => {
  const source: CloneSource = {
    path: '/work/tree',
    alias: 'crucible-1',
    entries: ['.claude', '.git', 'docs'],
    claudeEntries: ['rules', 'worktrees'],
    git: 'directory',
  };

  it('clones every entry but .claude/worktrees, then removes origin', () => {
    expect(planApfsClone(source, '/tmp/clone', 'darwin')).toEqual({
      ok: true,
      steps: [
        { kind: 'mkdir', path: '/tmp/clone' },
        { kind: 'spawn', command: 'cp', args: ['-c', '-R', '/work/tree/.git', '/tmp/clone/.git'] },
        { kind: 'spawn', command: 'cp', args: ['-c', '-R', '/work/tree/docs', '/tmp/clone/docs'] },
        { kind: 'mkdir', path: '/tmp/clone/.claude' },
        { kind: 'spawn', command: 'cp', args: ['-c', '-R', '/work/tree/.claude/rules', '/tmp/clone/.claude/rules'] },
        { kind: 'remove-origin', repository: '/tmp/clone' },
      ],
    });
  });

  it('refuses off macOS, naming buildVerbs', () => {
    expect(planApfsClone(source, '/tmp/clone', 'linux')).toMatchObject({
      ok: false,
      refusal: expect.stringContaining('buildVerbs: false'),
    });
  });

  it('refuses a git worktree subject, whose clone would share the real repository config', () => {
    expect(planApfsClone({ ...source, git: 'file' }, '/tmp/clone', 'darwin')).toMatchObject({
      ok: false,
      refusal: expect.stringContaining('git worktree'),
    });
  });

  it('does not touch remotes of a tree with no git', () => {
    const plan = planApfsClone({ ...source, git: 'none', entries: ['docs'], claudeEntries: null }, '/tmp/clone', 'darwin');

    expect(plan.ok && plan.steps.map((step) => step.kind)).toEqual(['mkdir', 'spawn']);
  });
});

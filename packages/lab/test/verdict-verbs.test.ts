/**
 * The verb matrix's argv and the APFS clone plan — both pure.
 */

import { describe, expect, it } from 'vitest';

import { type CloneDir, type CloneSource, planApfsClone } from '../src/facets/verdict/clone.js';
import { planBuildVerbs, verdictVerb, type VerbSubject } from '../src/facets/verdict/verbs.js';

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
    ['resources-validate', [['resources', 'validate', '/work/tree', '--verbose', '--format', 'json']]],
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

  const REASON = 'the subject needs a build artifact it has not produced';
  const plan = (buildVerbs: boolean, unmeasurable: Readonly<Record<string, string>>): ReturnType<typeof planBuildVerbs> =>
    planBuildVerbs({ buildVerbs, unmeasurableBuildVerbs: unmeasurable }, SUBJECT, PROBE_VERSION);

  it('spells the build verbs, build first, and excludes nothing by default', () => {
    expect(plan(true, {})).toEqual({
      invocations: [
        { name: 'build', argv: ['build'] },
        { name: 'verify', argv: ['verify'] },
        { name: 'marketplace-publish-dry-run', argv: ['claude', 'marketplace', 'publish', '--dry-run'] },
      ],
      excluded: [],
    });
  });

  it('plans nothing for a subject without buildVerbs', () => {
    expect(plan(false, {})).toEqual({ invocations: [], excluded: [] });
  });

  // A build that cannot finish leaves a half-written dist behind, and how far
  // it got differs between two builds — so it must not run before `verify`.
  // Never dropped: a verb that is not run cannot be caught changing.
  it('still runs a verb the subject cannot complete, after every verb it can, and records the exclusion', () => {
    const planned = plan(true, { build: REASON, 'marketplace-publish-dry-run': REASON });

    expect(planned.invocations.map((invocation) => invocation.name)).toEqual(['verify', 'build', 'marketplace-publish-dry-run']);
    expect(planned.excluded).toEqual([
      { name: 'build', reason: REASON },
      { name: 'marketplace-publish-dry-run', reason: REASON },
    ]);
  });
});

describe('planApfsClone', () => {
  /** A directory with no skipped entry beneath it: cloned whole. */
  const leaf = (...entries: string[]): CloneDir => ({ entries, descend: {} });
  const source: CloneSource = {
    path: '/work/tree',
    alias: 'crucible-1',
    root: { entries: ['.claude', '.git', 'docs'], descend: { '.claude': leaf('rules', 'worktrees') } },
    git: 'directory',
  };

  it('clones every entry but .claude/worktrees, then removes origin', () => {
    expect(planApfsClone(source, '/tmp/clone', 'darwin')).toEqual({
      ok: true,
      steps: [
        { kind: 'mkdir', path: '/tmp/clone' },
        { kind: 'mkdir', path: '/tmp/clone/.claude' },
        { kind: 'spawn', command: 'cp', args: ['-c', '-R', '/work/tree/.claude/rules', '/tmp/clone/.claude/rules'] },
        { kind: 'spawn', command: 'cp', args: ['-c', '-R', '/work/tree/.git', '/tmp/clone/.git'] },
        { kind: 'spawn', command: 'cp', args: ['-c', '-R', '/work/tree/docs', '/tmp/clone/docs'] },
        { kind: 'remove-origin', repository: '/tmp/clone' },
      ],
    });
  });

  // Ruling 62: a `.turbo` cache cloned for 4+ minutes. Regenerable caches are
  // not the subject, at the root or nested in a workspace package.
  // node_modules is CLONED: the subject's build resolves bare specifiers through it.
  it('skips .turbo at any depth but clones node_modules whole, descending only where a skip lies', () => {
    const monorepo: CloneSource = {
      ...source,
      git: 'none',
      root: {
        entries: ['.turbo', 'node_modules', 'packages', 'README.md'],
        descend: {
          packages: {
            entries: ['a', 'b'],
            descend: { a: leaf('src', 'node_modules', '.turbo', 'package.json') },
          },
        },
      },
    };

    const plan = planApfsClone(monorepo, '/tmp/clone', 'darwin');
    const cloned = plan.ok ? plan.steps.flatMap((step) => (step.kind === 'spawn' ? [step.args[2]] : [])) : [];

    expect(cloned).toEqual([
      '/work/tree/node_modules',
      '/work/tree/packages/a/src',
      '/work/tree/packages/a/node_modules',
      '/work/tree/packages/a/package.json',
      '/work/tree/packages/b',
      '/work/tree/README.md',
    ]);
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
    const plan = planApfsClone({ ...source, git: 'none', root: leaf('docs') }, '/tmp/clone', 'darwin');

    expect(plan.ok && plan.steps.map((step) => step.kind)).toEqual(['mkdir', 'spawn']);
  });
});

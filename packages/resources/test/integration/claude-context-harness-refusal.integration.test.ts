/**
 * A memory file the bounded worker refuses, end to end through the real lane.
 *
 * The harness facts lane reads every file the import frontier reaches in the
 * parse worker, under the run's limits. `deep.ts` declares one import more than
 * the default output cap, so the worker stops at `outputRows` with no test-only
 * limit in play. The run must name it, by the population's refusal code, and
 * store nothing for it (ADR I1, I6). Every other file must come out exactly as
 * in a twin tree where `deep.ts` is ordinary.
 */

import { describe, expect, it } from 'vitest';

import { resolveParseLimits } from '../../src/parse-limits.js';
import { RULE_SCOPE_TAG } from '../../src/projection/agentic-tags.js';
import { BLOB_PARSE_LIMIT_EXCEEDED, storableBlobFacts } from '../../src/projection/blob-population.js';
import { describeBlobRefusals, notAdmittedRealizations } from '../../src/projection/blob-refusals.js';
import { whatLoadsAt, type LoadedContext } from '../../src/projection/claude-context-query.js';
import type { Projection } from '../../src/projection/projection.js';

import { setupClaudeContextTree } from './claude-context-tree.js';

/** The file the worker refuses: past the default row cap, by one import. */
const REFUSED = 'deep.ts';

/** A path-scoped rule the worker refuses: its `paths:` are never read. */
const REFUSED_RULE = '.claude/rules/scoped.md';

/** One import more than the default cap allows a single read to produce. */
const PAST_THE_CAP = Array.from({ length: resolveParseLimits(undefined).outputRows + 1 }, (_, index) => `@a${index}.md`)
  .join('\n');

/** The two trees differ ONLY in `deep.ts`. */
function treeWith(deep: string): Record<string, string> {
  return {
    'CLAUDE.md': `# Root\n\n@${REFUSED}\n@docs/handbook.md\n`,
    [REFUSED]: deep,
    'docs/handbook.md': '# Handbook\n\n@one.md\n',
    'docs/one.md': '# One\n',
    '.claude/rules/scoped.md': "---\npaths: ['src/**/*.ts']\n---\n\nTypeScript only.\n",
  };
}

const refusedTree = setupClaudeContextTree(treeWith(`${PAST_THE_CAP}\n`));
const refusedRuleTree = setupClaudeContextTree({
  'CLAUDE.md': '# Root\n',
  [REFUSED_RULE]: `---\npaths: ['src/**/*.ts']\n---\n\n${PAST_THE_CAP}\n`,
  'src/index.ts': 'export {};\n',
  'docs/readme.md': '# Readme\n',
});
const ordinaryTree = setupClaudeContextTree(treeWith('// nothing to import\n'));

/** The content key of the one realization at `path`. */
function keyAt(projection: Projection, path: string): string {
  const key = projection.resourceRealizations.find((row) => row.path === path)?.contentKey;
  if (key === undefined || key === null) throw new Error(`no keyed realization at ${path}`);
  return key;
}

/** Every harness row of the projection, except those for `skip`. */
function harnessRowsExcept(projection: Projection, skip: string): unknown[] {
  return [
    ...projection.harnessBlobFacts.filter((row) => row.blob !== skip),
    ...projection.harnessBlobImports.filter((row) => row.blob !== skip),
  ];
}

describe('a memory file the parse worker refuses', () => {
  it('is recorded under the population refusal code, by name, and nothing is stored for it', () => {
    const projection = refusedTree.projection();
    const key = keyAt(projection, REFUSED);

    expect(projection.blobConditions.filter((row) => row.blob === key).map((row) => row.code))
      .toEqual([BLOB_PARSE_LIMIT_EXCEEDED]);
    expect(projection.harnessBlobFacts.filter((row) => row.blob === key)).toEqual([]);
    expect(projection.harnessBlobImports.filter((row) => row.blob === key)).toEqual([]);
    // Per run (I6): the shared store never files the refusal.
    expect(storableBlobFacts(projection).blobConditions.filter((row) => row.blob === key)).toEqual([]);
  });

  it('surfaces through the not-admitted log and the refusal line', () => {
    const projection = refusedTree.projection();
    const root = refusedTree.dir() ?? '';
    const { parseRefused } = notAdmittedRealizations(projection, root);

    expect(parseRefused.map((entry) => ({ path: entry.filePath.slice(root.length + 1), code: entry.code })))
      .toEqual([{ path: REFUSED, code: 'RESOURCE_PARSE_LIMIT_EXCEEDED' }]);
    expect(describeBlobRefusals(projection)).toMatch(/declined 1 of \d+ blob\(s\)/);
  });

  it('follows none of its imports, and leaves every other file exactly as the ordinary twin has it', () => {
    const refused = refusedTree.projection();
    const ordinary = ordinaryTree.projection();

    expect(refused.resourceRealizations.some((row) => row.path === 'a0.md')).toBe(false);
    expect(harnessRowsExcept(refused, keyAt(refused, REFUSED)))
      .toStrictEqual(harnessRowsExcept(ordinary, keyAt(ordinary, REFUSED)));
    // The twin really is ordinary: its `deep.ts` was read, not refused.
    expect(ordinary.blobConditions.filter((row) => row.code === BLOB_PARSE_LIMIT_EXCEEDED)).toEqual([]);
  });

  it('answers a context query without throwing over the refused file', () => {
    const projection = refusedTree.projection();
    expect(() => whatLoadsAt(projection, 'src/index.ts')).not.toThrow();
  });
});

/** The answer at `path`, asserted to be one. */
function answerAt(projection: Projection, path: string): Extract<LoadedContext, { kind: 'answer' }> {
  const answer = whatLoadsAt(projection, path);
  if (answer.kind !== 'answer') throw new Error(`no answer at ${path}`);
  return answer;
}

describe('a rules file whose harness facts were refused', () => {
  it('is never classified: no rule-scope tag says what its unread paths: imply', () => {
    const projection = refusedRuleTree.projection();
    const rule = projection.resourceRealizations.find((row) => row.path === REFUSED_RULE);

    expect(rule).toBeDefined();
    expect(projection.resourceTags.filter((row) => row.resourceId === rule?.resourceId && row.tag === RULE_SCOPE_TAG))
      .toEqual([]);
  });

  // A directory query is the launch alone; a file query adds the read walk.
  it.each([
    { query: 'docs', label: 'kept out of the launch tally' },
    { query: 'src/index.ts', label: 'not charged on a read of a file its globs name' },
  ])('is $label, and named as refused instead', ({ query }) => {
    const answer = answerAt(refusedRuleTree.projection(), query);

    expect(answer.rows.map((row) => row.path)).toEqual(['CLAUDE.md']);
    expect(answer.refused).toEqual([
      { path: REFUSED_RULE, code: 'RESOURCE_PARSE_LIMIT_EXCEEDED', reason: expect.stringContaining('outputRows') },
    ]);
  });
});

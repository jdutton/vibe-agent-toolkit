/**
 * `whatLoadsAt` over a REAL populated tree.
 *
 * Every other suite behind `vat claude context` runs against hand-built rows,
 * which is right for the logic and blind to three things: a stale `dist/`, a
 * parameter set filed under an id no contributor answers to, and a
 * membership/provenance disagreement. All three need a filesystem, one
 * enumeration and one query over the SAME tree, which is what this file is.
 *
 * So the assertions here deliberately do not re-test the logic. They test that
 * the population lane, the two classifiers, the closure primitive and the query
 * agree — that the paths the enumerator wrote are the paths the answer names,
 * that identity survives a real path round-trip, and that nothing the answer
 * charges is a member the provenance walk cannot explain.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  whatLoadsAt,
  type LoadedContext,
  type LoadedContextAnswer,
} from '../../src/projection/claude-context-query.js';
import { CLAUDE_IMPORT_CONTRIBUTOR_ID_PREFIX } from '../../src/projection/contributors/claude-import-extent.js';
import type { Projection } from '../../src/projection/projection.js';
import { ExtentDeclarationSchema } from '../../src/schemas/project-config.js';

import { buildClaudeContextTree, byCodePoint, removeClaudeContextTree } from './claude-context-tree.js';

/**
 * The tree.
 *
 * ⚠️ `docs/CLAUDE.md` imports `@handbook.md`, NOT `@docs/handbook.md`: a
 * reference resolves against the directory of the REFERRING file. The second
 * spelling would resolve to `docs/docs/handbook.md`, land
 * `CLOSURE_REFERENCE_UNRESOLVED`, and leave a suite that looks like it proves
 * a two-root diamond while proving nothing.
 *
 * `packages/cli/.claude/rules/local.md` imports out of its own directory on
 * purpose: it is a NESTED rules file, so the session loads it on demand, and
 * its import target must inherit that class rather than being charged to the
 * launch-time budget. `@../guide.md` lands in `packages/cli/.claude/`, which is
 * outside `.claude/rules/` and so is not itself a rules file — the target has
 * to earn its class from the importer, not from its own path.
 */
const TREE: Record<string, string> = {
  'CLAUDE.md': '# Root\n\n@docs/handbook.md\n',
  'docs/CLAUDE.md': '# Docs\n\n@handbook.md\n',
  'docs/handbook.md': '# Handbook\n\n@deep/one.md\n',
  'docs/deep/one.md': '# One\n',
  '.claude/rules/always.md': 'Always applies.\n',
  '.claude/rules/scoped.md': "---\npaths: ['packages/**/*.ts']\n---\n\nTypeScript only.\n",
  'packages/cli/.claude/rules/local.md': 'Nested.\n\n@../guide.md\n',
  'packages/cli/.claude/guide.md': '# Guide\n',
  'packages/cli/src/index.ts': 'export const answer = 42;\n',
};

/** The file query every exactness assertion is made at. */
const QUERIED_FILE = 'packages/cli/src/index.ts';

/** The directory the same rules apply to, minus the glob's exactness. */
const QUERIED_DIR = 'packages/cli/src';

/** The path-scoped rule, whose admission differs between the two queries above. */
const SCOPED_RULE = '.claude/rules/scoped.md';

/** The nested rule — on demand, and the reason its import target is too. */
const NESTED_RULE = 'packages/cli/.claude/rules/local.md';

/** The nested rule's import target, one directory up and NOT itself a rules file. */
const NESTED_RULE_TARGET = 'packages/cli/.claude/guide.md';

/** The diamond's join point: imported by both `CLAUDE.md` and `docs/CLAUDE.md`. */
const HANDBOOK = 'docs/handbook.md';

/** The hop-2 member, reachable only by following an import out of an import. */
const DEEP = 'docs/deep/one.md';

let treeDir: string | undefined;
let projection: Projection;

beforeAll(async () => {
  const tree = await buildClaudeContextTree(TREE);
  treeDir = tree.dir;
  projection = tree.projection;
}, 60_000);

afterAll(async () => {
  // Generous, and deliberately so: a recursive `rm` over a temp tree has timed
  // out at Vitest's 10s hook default on Windows CI, which fails the whole file
  // for a reason that has nothing to do with what it tests.
  await removeClaudeContextTree(treeDir);
}, 60_000);

/**
 * Assert a result IS an answer, and narrow it.
 *
 * @param result - Whatever `whatLoadsAt` returned
 * @returns The same value, narrowed
 */
function narrowed(result: LoadedContext): LoadedContextAnswer {
  expect(result.kind).toBe('answer');
  if (result.kind !== 'answer') throw new Error('unreachable — asserted above');
  return result;
}

/**
 * The answer at one path, narrowed.
 *
 * @param path - Root-relative path to query
 * @returns The answer
 */
function answerAt(path: string): LoadedContextAnswer {
  return narrowed(whatLoadsAt(projection, path));
}

/**
 * One answer's row at a path, or undefined.
 *
 * @param answer - The answer
 * @param path - Root-relative path
 * @returns The row, or undefined
 */
function rowAt(answer: LoadedContextAnswer, path: string): LoadedContextAnswer['rows'][number] | undefined {
  return answer.rows.find((row) => row.path === path);
}

describe('whatLoadsAt over a real populated tree', () => {
  it('answers a FILE query exactly, including the path-scoped rule', () => {
    const answer = answerAt(QUERIED_FILE);

    // ⛔ EXHAUSTIVE, and the two entries a reader would not predict are the
    // point. `docs/deep/one.md` is charged because the closure follows an
    // import OUT OF an import — a set stopping at `docs/handbook.md` cannot
    // tell a working depth counter from one that quits at hop 1. And
    // `packages/cli/.claude/guide.md` is charged because a nested rules file
    // has its own closure: a query that admits the rule admits what the rule
    // imports. `docs/CLAUDE.md` is absent because it is nobody's ancestor from
    // here, which is what keeps a tree-global over-report visible.
    expect(answer.rows.map((row) => row.path).sort(byCodePoint)).toEqual([
      '.claude/rules/always.md',
      SCOPED_RULE,
      'CLAUDE.md',
      DEEP,
      HANDBOOK,
      NESTED_RULE_TARGET,
      NESTED_RULE,
    ].sort(byCodePoint));
  });

  it('answers the same DIRECTORY query with the glob rule as "may fire", not as a match', () => {
    const scoped = rowAt(answerAt(QUERIED_DIR), SCOPED_RULE);

    expect(scoped?.admissions).toEqual([{ kind: 'glob-rule-may-fire' }]);
    expect(scoped?.loadClass).toBe('on-demand');
  });

  it('keeps the matched glob rule on-demand for the FILE query, and out of the launch set', () => {
    const answer = answerAt(QUERIED_FILE);
    const scoped = rowAt(answer, SCOPED_RULE);

    // The gap this closes: the file query above admits this same file and never
    // asserted its class, so `glob-rule` sat in the `always` set — on THIS
    // repository, where three real `.claude/rules/*.md` carry `paths:` — and
    // charged the rule plus its whole @-import closure to "Loaded at launch".
    // Both halves are asserted: the glob really did match (so this is not the
    // "may fire" case wearing a file query's clothes), and it is still on demand.
    expect(scoped?.admissions).toEqual([{ kind: 'glob-rule', pattern: 'packages/**/*.ts' }]);
    expect(scoped?.loadClass).toBe('on-demand');
    // The launch set over a REAL tree, exhaustively: the unscoped root rule and
    // the ancestor CLAUDE.md's closure, and nothing path-scoped.
    expect(answer.rows.filter((row) => row.loadClass === 'always').map((row) => row.path).sort(byCodePoint))
      .toEqual(['.claude/rules/always.md', 'CLAUDE.md', HANDBOOK, DEEP].sort(byCodePoint));
  });

  it('resolves an import RELATIVE TO THE IMPORTER, not to the corpus root', () => {
    const handbook = rowAt(answerAt('docs'), HANDBOOK);

    expect(handbook?.admissions).toContainEqual({
      kind: 'import', rootPath: 'docs/CLAUDE.md', viaPath: 'docs/CLAUDE.md', depth: 1,
    });
  });

  it('charges the transitive import once, with its real depth', () => {
    const deep = answerAt('docs').rows.filter((row) => row.path === DEEP);

    expect(deep).toHaveLength(1);
    expect(deep[0]?.admissions.some((a) => a.kind === 'import' && a.depth === 2)).toBe(true);
  });

  it('excludes the nested rules file from a query outside its subtree', () => {
    expect(answerAt('docs').rows.map((row) => row.path)).not.toContain(NESTED_RULE);
  });

  it('propagates the import class from the closure ROOT, not from the fact of the import', () => {
    const answer = answerAt(QUERIED_FILE);

    expect(rowAt(answer, NESTED_RULE)?.loadClass).toBe('on-demand');
    expect(rowAt(answer, NESTED_RULE_TARGET)?.loadClass).toBe('on-demand');
    expect(rowAt(answer, HANDBOOK)?.loadClass).toBe('always');
  });

  it('attributes every member it charges', () => {
    expect(answerAt(QUERIED_FILE).unattributedImports).toEqual([]);
    expect(answerAt('docs').unattributedImports).toEqual([]);
  });

  it('keeps a path the enumeration never realized distinguishable from an empty answer', () => {
    expect(whatLoadsAt(projection, 'packages/cli/src/absent.ts')).toEqual({
      kind: 'unknown',
      input: 'packages/cli/src/absent.ts',
      reason: 'path-not-realized',
    });
  });

  it('reads back the parameter set the population wrote, keyed to a realized root', () => {
    const realizedPaths = new Set(projection.resourceRealizations.map((row) => row.path));
    const declarations = projection.zoneProvenance
      .filter((row) => row.contributorId.startsWith(`${CLAUDE_IMPORT_CONTRIBUTOR_ID_PREFIX}:`))
      .map((row) => ExtentDeclarationSchema.parse(row.parameterSet));

    expect(declarations).not.toHaveLength(0);
    for (const declaration of declarations) {
      expect(declaration.referenceDialect).toBe('claude-import');
      expect(declaration.follow).toEqual(['at-prefixed']);
      expect(realizedPaths.has(declaration.closureFrom)).toBe(true);
    }
  });

  it('carries a real token cost on every charged row, never a confident zero', () => {
    for (const row of answerAt(QUERIED_FILE).rows) {
      expect(row.tokens).toBeGreaterThan(0);
      expect(row.bytes).toBeGreaterThan(0);
    }
  });

  it('reports no condition on a tree whose every import resolves', () => {
    expect(answerAt(QUERIED_FILE).conditions).toEqual([]);
  });
});

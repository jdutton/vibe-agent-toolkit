/**
 * Randomized DIFFERENTIAL test of `vat claude context`'s answer against a
 * reference port of Claude Code's own memory loader — the small, unit-budget
 * sweep, the reference's own honesty checks, and one minimal regression per
 * divergence class the sweep found.
 *
 * The engine and generator live in `helpers/claude-loader-differential.ts`, the
 * reference in `helpers/claude-loader-reference.ts`; their headers say what is
 * compared and why. This sweeps seeds 1–8 WITHOUT the `oversize` group — a
 * 4 MiB file costs VAT's parser most of a second — and the integration tier
 * continues from seed 9 (300 in memory, then 200 on real trees on disk), so
 * the two tiers together sweep one contiguous prefix, plus the oversize cases.
 * Re-run one failing seed with `LOADER_DIFFERENTIAL_SEED=<n>`.
 */

import { describe, expect, it } from 'vitest';

import { whatLoadsAt, type LoadedContextAnswer } from '../src/projection/claude-context-query.js';

import {
  FAST_SETTLED_FEATURES,
  inMemoryProjection as inMemory,
  loaderDifferentialFailures,
  loaderDivergences,
  loaderSweepSeeds,
} from './helpers/claude-loader-differential.js';
import { filesOnRead, launchFiles, type LoadedMemoryFile } from './helpers/claude-loader-reference.js';

/** Seeds 1–8: the smoke range, inside the unit per-file budget under coverage; the integration tier is the sweep. */
const UNIT_SEEDS = loaderSweepSeeds(1, 8);

/** The settled groups this tier can afford: all but the 4 MiB files. */
const UNIT_FEATURES = FAST_SETTLED_FEATURES;

/** A path-scoped root rule, its `paths:` spelled once. */
const SCOPED = "---\npaths: ['src/**']\n---\n";

/** The launch set of a session in `cwd`, by path. */
function launched(files: Record<string, string>, cwd: string): string[] {
  return launchFiles(new Map(Object.entries(files)), cwd, { externalIncludesApproved: true })
    .map((entry) => entry.path);
}

/** The single loaded entry at `path` in a launch, or undefined. */
function launchedEntry(files: Record<string, string>, cwd: string, path: string): LoadedMemoryFile | undefined {
  return launchFiles(new Map(Object.entries(files)), cwd, { externalIncludesApproved: true })
    .find((entry) => entry.path === path);
}

/** VAT's answer for a query file, narrowed. */
async function vatAnswer(files: Record<string, string>, query: string): Promise<LoadedContextAnswer> {
  const answer = whatLoadsAt(await inMemory(files), query);
  if (answer.kind !== 'answer') throw new Error(`VAT answered unknown for ${query}`);
  return answer;
}

/** The load class VAT gives `path` in its answer for `query`, or undefined when absent. */
async function vatClass(files: Record<string, string>, query: string, path: string): Promise<string | undefined> {
  return (await vatAnswer(files, query)).rows.find((row) => row.path === path)?.loadClass;
}

describe('vat claude context agrees with a reference port of the Claude Code loader', () => {
  it('on what loads at launch and on read, across seeded random trees', async () => {
    const failures = await loaderDifferentialFailures(UNIT_SEEDS, UNIT_FEATURES, inMemory);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('keeps the positive control: the comparison reds on an answer VAT gets wrong', async () => {
    // VAT answers for a tree whose CLAUDE.md imports `x.md`; the reference
    // reads one where `(@x.md)` is not an import (`Ayn` needs whitespace or a
    // line start before the `@`). A comparison that cannot report every
    // dimension of that disagreement proves nothing about the cases it passes.
    const files = { 'CLAUDE.md': '(@x.md)\n', 'x.md': 'x\n' };
    const wrong = () => inMemory({ ...files, 'CLAUDE.md': '@x.md\n' });
    expect(await loaderDivergences({ seed: 0, files, queries: ['CLAUDE.md'] }, wrong)).toEqual([
      'imports: CLAUDE.md imports [], VAT reads ["x.md"]',
      'query CLAUDE.md: launch: VAT charges x.md, reference does not load it',
    ]);
  });
});

describe('the reference reads imports the way the binary does', () => {
  it.each([
    ['(@a.md)', []],
    ['**@a.md**', ['a.md']],
    ['_@a.md_ and [@a.md](https://example.com)', ['a.md']],
    ['`@a.md` and\n\n```\n@a.md\n```', []],
    ['<div>@a.md</div>', []],
    ['<!-- @a.md -->', []],
    [String.raw`\@a.md`, []],
    ['@a.md#section', ['a.md']],
    ['- @a.md', ['a.md']],
  ])('%j imports %j', (source, expected) => {
    const files = { 'CLAUDE.md': `${source}\n`, 'a.md': 'a\n' };
    expect(launched(files, '').filter((path) => path !== 'CLAUDE.md')).toEqual(expected);
  });

  it('keeps trailing punctuation, so `@a.md.` names a non-text `a.md.` and loads nothing', () => {
    expect(launched({ 'CLAUDE.md': 'Read @a.md.\n', 'a.md': 'a\n' }, '')).toEqual(['CLAUDE.md']);
  });

  it('reads `\\ ` as a space in the path', () => {
    expect(launched({ 'CLAUDE.md': String.raw`@my\ file.md` + '\n', 'my file.md': 'm\n' }, ''))
      .toEqual(['CLAUDE.md', 'my file.md']);
  });

  it('injects the body without frontmatter or comment blocks, trimmed', () => {
    const files = { 'CLAUDE.md': '---\ndescription: d\n---\n<!-- note -->\n\nBody.\n\n' };
    expect(launchedEntry(files, '', 'CLAUDE.md')?.injected).toBe('Body.');
  });

  it('drops a file that injects nothing, and never follows its imports', () => {
    const files = { 'CLAUDE.md': '@a.md\n', 'a.md': '---\nx: 1\n---\n', 'b.md': 'b\n' };
    expect(launched({ ...files, 'a.md': '<!-- @b.md -->\n' }, '')).toEqual(['CLAUDE.md']);
    expect(launched(files, '')).toEqual(['CLAUDE.md']);
  });

  it('follows four hops and refuses the fifth', () => {
    const chain = { 'CLAUDE.md': '@1.md\n', '1.md': '@2.md\n', '2.md': '@3.md\n', '3.md': '@4.md\n', '4.md': '@5.md\n', '5.md': '5\n' };
    expect(launched(chain, '')).toEqual(['CLAUDE.md', '1.md', '2.md', '3.md', '4.md']);
  });

  it('matches a nested rule on read relative to ITS directory, and never consults a rules directory off the chain', () => {
    const files = { 'pkg/.claude/rules/r.md': "---\npaths: ['src/**']\n---\nr\n", 'pkg/src/a.ts': 'a\n', 'src/b.ts': 'b\n' };
    const tree = new Map(Object.entries(files));
    expect(filesOnRead(tree, 'pkg/src', 'pkg/src/a.ts', new Set()).map((entry) => entry.path)).toEqual(['pkg/.claude/rules/r.md']);
    expect(filesOnRead(tree, 'src', 'src/b.ts', new Set())).toEqual([]);
  });
});

describe('each divergence class the differential found, pinned at its minimal case', () => {
  it('loads an unscoped NESTED rule at launch — every directory on the walk reads its .claude/rules', async () => {
    const files = { 'pkg/.claude/rules/r.md': 'nested rule\n', 'pkg/a.md': 'a\n' };
    expect(await vatClass(files, 'pkg/a.md', 'pkg/.claude/rules/r.md')).toBe('always');
    expect(await loaderDivergences({ seed: 0, files, queries: ['pkg/a.md'] }, inMemory)).toEqual([]);
  });

  it('loads a nested .claude/CLAUDE.md at launch, not only the root one', async () => {
    const files = { 'pkg/.claude/CLAUDE.md': 'second location\n', 'pkg/a.md': 'a\n' };
    expect(await vatClass(files, 'pkg/a.md', 'pkg/.claude/CLAUDE.md')).toBe('always');
    expect(await loaderDivergences({ seed: 0, files, queries: ['pkg/a.md'] }, inMemory)).toEqual([]);
  });

  it('loads a path-scoped rule\'s UNSCOPED import at launch, while the rule waits for its glob', async () => {
    const files = { '.claude/rules/s.md': `${SCOPED}@../../docs/h.md\n`, 'docs/h.md': 'h\n', 'docs/q.md': 'q\n' };
    const answer = await vatAnswer(files, 'docs/q.md');
    expect(answer.rows.map((row) => [row.path, row.loadClass])).toEqual([['docs/h.md', 'always']]);
    expect(await loaderDivergences({ seed: 0, files, queries: ['docs/q.md'] }, inMemory)).toEqual([]);
  });

  it('spends a file once per launch: a scoped rule the rules walk dropped is not re-read by a later import', async () => {
    const files = { '.claude/rules/s.md': `${SCOPED}s\n`, 'pkg/CLAUDE.md': '@../.claude/rules/s.md\n', 'pkg/a.md': 'a\n' };
    expect(await vatClass(files, 'pkg/a.md', '.claude/rules/s.md')).toBeUndefined();
    expect(await loaderDivergences({ seed: 0, files, queries: ['pkg/a.md'] }, inMemory)).toEqual([]);
  });

  it('walks depth-first: a file first reached at the fourth hop keeps its fifth-hop import out', async () => {
    const files = {
      'CLAUDE.md': '@1.md\n', '1.md': '@2.md\n', '2.md': '@3.md\n', '3.md': '@4.md\n', '4.md': '@5.md\n', '5.md': '5\n',
      '.claude/rules/r.md': '@../../4.md\n',
    };
    expect(await vatClass(files, 'CLAUDE.md', '5.md')).toBeUndefined();
    expect(await loaderDivergences({ seed: 0, files, queries: ['CLAUDE.md'] }, inMemory)).toEqual([]);
  });

  it('never loads an import whose extension is not text', async () => {
    const files = { 'CLAUDE.md': '@logo.png\n', 'logo.png': 'PNG\n' };
    expect(await vatClass(files, 'CLAUDE.md', 'logo.png')).toBeUndefined();
    expect(await loaderDivergences({ seed: 0, files, queries: ['CLAUDE.md'] }, inMemory)).toEqual([]);
  });

  it('agrees that an import through a variable loads nothing — the harness rejects a `$`-led path too', async () => {
    // `Ayn` accepts a bare path only when it starts `[a-zA-Z0-9._-]`, so
    // `@${VAR}/a.md` and `@$HOME/a.md` are not imports there either: the
    // `variable-imports-unfollowed` limit described an under-report that is not one.
    const files = { 'CLAUDE.md': '@${VAR}/a.md\n@$HOME/a.md\n', '${VAR}/a.md': 'a\n', '$HOME/a.md': 'b\n' };
    expect(launched(files, '')).toEqual(['CLAUDE.md']);
    expect(await loaderDivergences({ seed: 0, files, queries: ['CLAUDE.md'] }, inMemory)).toEqual([]);
  });

  it('loads a path-scoped IMPORT on read when the read file matches its OWN globs', async () => {
    // The sweep's seed 72. `y3` judges every path-scoped entry of a rules
    // file's closure by its own `paths:`, so `shared.txt` — imported by an
    // unscoped rule, left out at launch — loads when `a.md` is read.
    const files = {
      '.claude/rules/r.md': 'r\n\n@../../shared.txt\n',
      'shared.txt': "---\npaths: ['*.md']\n---\nshared\n",
      'a.md': 'a\n',
      'b.ts': 'b\n',
    };
    expect(await vatClass(files, 'a.md', 'shared.txt')).toBe('on-demand');
    expect(await vatClass(files, 'b.ts', 'shared.txt')).toBeUndefined();
    expect(await loaderDivergences({ seed: 0, files, queries: ['a.md', 'b.ts'] }, inMemory)).toEqual([]);
  });

  it('judges an imported scoped file relative to the rules directory WALKED, not its own', async () => {
    // The sweep's seed 55. A root rule imports a NESTED rules file; reached
    // through the root walk first, it is judged relative to the ROOT (`LO(LO(n))`
    // of the directory being walked) and spent, so its own directory never
    // gets to judge it.
    const files = {
      '.claude/rules/r.md': 'r\n\n@../../pkg/.claude/rules/s.md\n',
      'pkg/.claude/rules/s.md': "---\npaths: ['*.md']\n---\ns\n",
      'CLAUDE.md': 'root\n',
    };
    expect(await vatClass(files, 'CLAUDE.md', 'pkg/.claude/rules/s.md')).toBe('on-demand');
    expect(await loaderDivergences({ seed: 0, files, queries: ['CLAUDE.md'] }, inMemory)).toEqual([]);
  });

  it('never follows an import out of the session directory on read', async () => {
    // `y3` is called with `includeExternal` false: a scoped rule's import that
    // leaves the working directory is not read, even with launch approval.
    const files = {
      'pkg/.claude/rules/r.md': 'r\n\n@../../../docs/x.md\n',
      'docs/x.md': "---\npaths: ['*.md']\n---\nx\n",
      'pkg/a.md': 'a\n',
    };
    expect(await vatClass(files, 'pkg/a.md', 'docs/x.md')).toBeUndefined();
    expect(await loaderDivergences({ seed: 0, files, queries: ['pkg/a.md'] }, inMemory)).toEqual([]);
  });

  it('reads `@` imports as the harness does: only after whitespace, punctuation kept, emphasis and links descended', async () => {
    const files = {
      'CLAUDE.md': '(@a.md) and @b.md. then **@c.md** and [@d.md](https://example.com) and @my\\ file.md\n',
      'a.md': 'a\n', 'b.md': 'b\n', 'c.md': 'c\n', 'd.md': 'd\n', 'my file.md': 'm\n',
    };
    expect((await vatAnswer(files, 'CLAUDE.md')).rows.map((row) => row.path)).toEqual(['CLAUDE.md', 'c.md', 'd.md', 'my file.md']);
    expect(await loaderDivergences({ seed: 0, files, queries: ['CLAUDE.md'] }, inMemory)).toEqual([]);
  });

  it('reads a NON-markdown import with the same lexer: a `@` in a `.ts` code span is not an import', async () => {
    // The on-disk sweep's seed 2006. The harness lexes every memory file with
    // `marked`, whatever its extension, so `` `@../x.md` `` in `index.ts` is a
    // code span and imports nothing.
    const files = { 'CLAUDE.md': '@src/index.ts\n', 'src/index.ts': 'export {};\n\n`@../x.md`\n', 'x.md': 'x\n' };
    expect(await vatClass(files, 'CLAUDE.md', 'x.md')).toBeUndefined();
    expect(await loaderDivergences({ seed: 0, files, queries: ['CLAUDE.md'] }, inMemory)).toEqual([]);
  });

  it('charges the injected text: frontmatter and comment blocks removed, trimmed', async () => {
    const body = 'Body text that is charged.';
    const files = { 'CLAUDE.md': `---\ndescription: not injected\n---\n<!-- a maintainer note, not injected -->\n\n${body}\n\n` };
    const row = (await vatAnswer(files, 'CLAUDE.md')).rows.find((candidate) => candidate.path === 'CLAUDE.md');
    expect(row?.tokens).toBe(Math.ceil(body.length / 4));
    expect(await loaderDivergences({ seed: 0, files, queries: ['CLAUDE.md'] }, inMemory)).toEqual([]);
  });

  it('drops a file that injects nothing, and never follows its imports', async () => {
    const files = { 'CLAUDE.md': '@a.md\n', 'a.md': '<!-- @b.md -->\n', 'b.md': 'b\n' };
    expect(await vatClass(files, 'CLAUDE.md', 'a.md')).toBeUndefined();
    expect(await vatClass(files, 'CLAUDE.md', 'b.md')).toBeUndefined();
    expect(await loaderDivergences({ seed: 0, files, queries: ['CLAUDE.md'] }, inMemory)).toEqual([]);
  });

  it('never reads a rules file whose extension is `.MD`', async () => {
    const files = { '.claude/rules/LOUD.MD': 'loud\n', 'a.md': 'a\n' };
    expect(await vatClass(files, 'a.md', '.claude/rules/LOUD.MD')).toBeUndefined();
    expect(await loaderDivergences({ seed: 0, files, queries: ['a.md'] }, inMemory)).toEqual([]);
  });
});

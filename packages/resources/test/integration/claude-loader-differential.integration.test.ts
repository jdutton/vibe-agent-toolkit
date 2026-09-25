/**
 * Randomized DIFFERENTIAL test of `vat claude context` against a reference port
 * of Claude Code's memory loader — the WIDE tier: seeds 9–508, continuing the
 * unit tier's 1–8 so the two together sweep one contiguous prefix, the
 * 4 MiB size-cliff cases the unit tier cannot afford, a sweep through REAL
 * on-disk trees populated by `buildClaudeContextPopulation`, with the on-disk
 * lane's own regressions pinned.
 *
 * The engine is `../helpers/claude-loader-differential.ts`; its header says
 * what is compared. Re-run one failing seed with `LOADER_DIFFERENTIAL_SEED=<n>`.
 */

import { describe, expect, it } from 'vitest';

import { claudeContextFixture } from '../helpers/claude-context-fixture.js';
import {
  loaderDifferentialFailures,
  loaderDivergences,
  loaderSweepSeeds,
  SETTLED_FEATURES,
} from '../helpers/claude-loader-differential.js';
import { LOADER_SIZE_CLIFF } from '../helpers/claude-loader-reference.js';

import { buildClaudeContextTree, removeClaudeContextTree } from './claude-context-tree.js';

/** VAT's projection, built in memory through the shipped contributors. */
const inMemory = (files: Readonly<Record<string, string>>) => claudeContextFixture({ ...files });

/** VAT's projection, populated from a real temp tree on disk — the production lane. */
async function onDisk(files: Readonly<Record<string, string>>) {
  const tree = await buildClaudeContextTree(files);
  await removeClaudeContextTree(tree.dir);
  return tree.projection;
}

/** The settled groups without the 4 MiB files, which cost VAT's parser most of a second each. */
const FAST_SETTLED = new Set(SETTLED_FEATURES.filter((feature) => feature !== 'oversize'));

/**
 * A body past the size cliff, in the shape VAT's parser gets through fastest
 * (one fenced block) — the cliff is about bytes, not about what they say.
 */
const OVERSIZE_BODY = `\n\`\`\`\n${'x'.repeat(LOADER_SIZE_CLIFF)}\n\`\`\`\n`;

describe('vat claude context agrees with a reference port of the Claude Code loader (wide sweep)', () => {
  it('in memory, across 300 seeded random trees (seeds 9–308)', async () => {
    const failures = await loaderDifferentialFailures(loaderSweepSeeds(9, 300), FAST_SETTLED, inMemory);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('on disk, through the production population lane (seeds 309–508)', async () => {
    const failures = await loaderDifferentialFailures(loaderSweepSeeds(309, 200), FAST_SETTLED, onDisk);
    expect(failures, failures.join('\n')).toEqual([]);
  }, 60_000);
});

describe('the on-disk lane reads imports and injected text as the harness does', () => {
  it('lexes a `.ts` import with the same lexer, so a `@` in its code span imports nothing (seed 2006)', async () => {
    // On disk a `.ts` file is routed to no parser, so VAT's generic lexer used
    // to read `` `@../x.md` `` as an import there while the in-memory lane read
    // it as markdown. `harness_blob_imports` is one extractor for both.
    const files = { 'CLAUDE.md': '@src/index.ts\n', 'src/index.ts': 'export {};\n\n`@../x.md`\n', 'x.md': 'x\n' };
    expect(await loaderDivergences({ seed: 0, files, queries: ['CLAUDE.md'] }, onDisk)).toEqual([]);
  });

  it('reads `paths:` off a `.ts` import the harness way, so a rule does not charge it at launch (seeds 2074, 2099, 2151)', async () => {
    // On disk a `.ts` file is routed to no parser and had no `blobs.frontmatter`,
    // so its `paths:` went unread: VAT charged it at launch under an unscoped
    // rule, and missed it on a matching read, while the in-memory lane — parsing
    // it as markdown — agreed with the harness. `harness_blob_facts.paths` is one reader.
    const files = {
      '.claude/rules/style.md': 'See @../../src/index.ts\n',
      'src/index.ts': '---\npaths:\n  - "src/**"\n---\nexport {};\n',
      'docs/a.md': 'a\n',
    };
    const testCase = { seed: 0, files, queries: ['docs/a.md', 'src/index.ts'] };
    expect(await loaderDivergences(testCase, onDisk)).toEqual([]);
    expect(await loaderDivergences(testCase, inMemory)).toEqual([]);
  });

  it('charges the injected text and drops a file that injects nothing', async () => {
    const files = {
      'CLAUDE.md': '---\ndescription: d\n---\n(@skip.md) @a.md **@c.md**\n<!-- note -->\n',
      'a.md': '<!-- @b.md -->\n', 'b.md': 'b\n', 'c.md': 'c\n', 'skip.md': 's\n',
    };
    expect(await loaderDivergences({ seed: 0, files, queries: ['CLAUDE.md'] }, onDisk)).toEqual([]);
  });
});

describe('the size cliff applies to every file the harness reads', () => {
  it('skips an oversize IMPORT and never follows what it imports', async () => {
    const files = { 'CLAUDE.md': '@big.md\n', 'big.md': `@small.md\n${OVERSIZE_BODY}`, 'small.md': 's\n' };
    expect(await loaderDivergences({ seed: 0, files, queries: ['CLAUDE.md'] }, inMemory)).toEqual([]);
  });

  it('skips an oversize RULE, and still loads its import when another route reaches it', async () => {
    const files = {
      '.claude/rules/big.md': `@../../shared.md\n${OVERSIZE_BODY}`,
      'CLAUDE.local.md': '@shared.md\n',
      'shared.md': 's\n',
    };
    expect(await loaderDivergences({ seed: 0, files, queries: ['shared.md'] }, inMemory)).toEqual([]);
  });
});

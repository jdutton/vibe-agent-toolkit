/**
 * Randomized DIFFERENTIAL test of `vat claude context` against a reference port
 * of Claude Code's memory loader — the WIDE tier, on disk through the production population lane: seeds 309–408.
 * The integration tier sweeps seeds 9–508 in four files (in-memory-a/b, on-disk-a/b), continuing
 * the unit tier's 1–8 so the tiers together sweep one contiguous prefix; it is
 * split only so each file fits the tier's per-file budget.
 *
 * The engine is `../helpers/claude-loader-differential.ts`; its header says
 * what is compared. Re-run one failing seed with `LOADER_DIFFERENTIAL_SEED=<n>`.
 */

import { describe, expect, it } from 'vitest';

import {
  FAST_SETTLED_FEATURES,
  inMemoryProjection,
  loaderDifferentialFailures,
  loaderDivergences,
  loaderSweepSeeds,
} from '../helpers/claude-loader-differential.js';

import { onDiskProjection } from './claude-context-tree.js';

describe('vat claude context agrees with a reference port of the Claude Code loader (wide sweep, on disk)', () => {
  it('across 100 seeded random trees (seeds 309–408)', async () => {
    const failures = await loaderDifferentialFailures(loaderSweepSeeds(309, 100), FAST_SETTLED_FEATURES, onDiskProjection);
    expect(failures, failures.join('\n')).toEqual([]);
  }, 60_000);
});

describe('the on-disk lane reads imports and injected text as the harness does', () => {
  it('lexes a `.ts` import with the same lexer, so a `@` in its code span imports nothing (seed 2006)', async () => {
    // On disk a `.ts` file is routed to no parser, so VAT's generic lexer used
    // to read `` `@../x.md` `` as an import there while the in-memory lane read
    // it as markdown. `harness_blob_imports` is one extractor for both.
    const files = { 'CLAUDE.md': '@src/index.ts\n', 'src/index.ts': 'export {};\n\n`@../x.md`\n', 'x.md': 'x\n' };
    expect(await loaderDivergences({ seed: 0, files, queries: ['CLAUDE.md'] }, onDiskProjection)).toEqual([]);
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
    expect(await loaderDivergences(testCase, onDiskProjection)).toEqual([]);
    expect(await loaderDivergences(testCase, inMemoryProjection)).toEqual([]);
  });

  it('charges the injected text and drops a file that injects nothing', async () => {
    const files = {
      'CLAUDE.md': '---\ndescription: d\n---\n(@skip.md) @a.md **@c.md**\n<!-- note -->\n',
      'a.md': '<!-- @b.md -->\n', 'b.md': 'b\n', 'c.md': 'c\n', 'skip.md': 's\n',
    };
    expect(await loaderDivergences({ seed: 0, files, queries: ['CLAUDE.md'] }, onDiskProjection)).toEqual([]);
  });
});

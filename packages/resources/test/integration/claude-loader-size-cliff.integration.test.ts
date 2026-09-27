/**
 * The size cliff in `vat claude context`, checked against a reference port of
 * Claude Code's memory loader: a file past `LOADER_SIZE_CLIFF` is skipped
 * wherever the harness reads it. Each case parses a 4 MiB body, which is why
 * these live apart from the seeded sweeps.
 *
 * The engine is `../helpers/claude-loader-differential.ts`; its header says
 * what is compared.
 */

import { describe, expect, it } from 'vitest';

import { inMemoryProjection as inMemory, loaderDivergences } from '../helpers/claude-loader-differential.js';
import { LOADER_SIZE_CLIFF } from '../helpers/claude-loader-reference.js';

/**
 * A body past the size cliff, in the shape VAT's parser gets through fastest
 * (one fenced block) — the cliff is about bytes, not about what they say.
 */
const OVERSIZE_BODY = `\n\`\`\`\n${'x'.repeat(LOADER_SIZE_CLIFF)}\n\`\`\`\n`;

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

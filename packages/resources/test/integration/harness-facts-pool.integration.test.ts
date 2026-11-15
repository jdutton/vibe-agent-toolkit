/**
 * A harness's memory-file read runs in the parse worker, under the pool's limits
 * (ADR I8): the facts the worker answers are the in-process reader's, byte for
 * byte, and a pathological memory file is stopped at a limit with the pool
 * surviving it — through the real built worker.
 */

import { describe, expect, it } from 'vitest';

import type { ParseLimitName } from '../../src/parse-limits.js';
import type { ParsePool } from '../../src/parse-pool.js';
import { claudeMemoryFactsOf } from '../../src/projection/claude-memory.js';
import { deeplyNestedQuote, limitedPools, limitStoppedAt, TIGHT_LIMITS } from '../parse-limit-fixtures.js';

const limitedPool = limitedPools();

/** Claude Code's read of `content` on the pool. */
function readOnPool(pool: ParsePool, content: string): ReturnType<ParsePool['harnessFacts']> {
  return pool.harnessFacts('claude-code', content, Buffer.byteLength(content, 'utf8'));
}

/** The limit a read was stopped at, failing if it was not stopped. */
async function breachOf(pool: ParsePool, content: string): Promise<ParseLimitName> {
  return limitStoppedAt(readOnPool(pool, content));
}

/** Memory files covering every fact the reader produces: frontmatter `paths:`, comments, imports, a BOM. */
const MEMORY_FILES: readonly string[] = [
  '# acme\n\n@docs/a.md\n',
  '---\npaths: ["src/**", "docs/**"]\n---\n<!-- gone --> kept\n\nSee @b.md and @a.md#x\n\n@b.md\n',
  '---\npaths: src/**, lib/*.ts\n---\n```\n@not-an-import.md\n```\n> quoted @c.md\n',
  `${String.fromCodePoint(0xfe_ff)}---\npaths: src/**\n---\nx\n`,
  'plain text, no imports\n',
  '',
];

describe('a harness read on the parse pool', () => {
  it('answers exactly what the in-process reader computes', async () => {
    const pool = limitedPool();
    for (const content of MEMORY_FILES) {
      await expect(readOnPool(pool, content)).resolves.toStrictEqual(claudeMemoryFactsOf(content));
    }
  });

  it('is stopped at its stack when the lexer recurses past it, and the pool still reads', async () => {
    const pool = limitedPool();
    await expect(breachOf(pool, `${deeplyNestedQuote().trimEnd()} @x.md\n`)).resolves.toBe('stackMb');
    await expect(readOnPool(pool, '@a.md\n')).resolves.toStrictEqual(claudeMemoryFactsOf('@a.md\n'));
  });

  it('is stopped at its row cap when the file declares more imports than the cap', async () => {
    const pool = limitedPool();
    const imports = Array.from({ length: TIGHT_LIMITS.outputRows + 1 }, (_, index) => `@docs/a${index}.md`).join('\n');
    await expect(breachOf(pool, `${imports}\n`)).resolves.toBe('outputRows');
  });

  it('is refused before dispatch when the file is past the input cap', async () => {
    const pool = limitedPool({ inputBytes: 64 });
    await expect(breachOf(pool, `${'x'.repeat(65)}\n`)).resolves.toBe('inputBytes');
  });
});

/**
 * The `data` job on the parse pool, through the real built worker: it answers
 * exactly what the extractor computes in-process, a parse error is the
 * document's answer, an output cap (depth included) is a `ParseLimitError` the
 * pool survives. A thread that dies holding the job is seeded in
 * `parse-pool.test.ts` ("a thread that dies holding a data job").
 */

import { describe, expect, it } from 'vitest';

import type { ParsePool } from '../src/parse-pool.js';
import { extractDataRows } from '../src/projection/data-extractor.js';
import type { DataVariant } from '../src/schemas/projection-data.js';

import { limitedPools, limitStoppedAt, TIGHT_LIMITS } from './parse-limit-fixtures.js';

const limitedPool = limitedPools();

/** `text`'s extraction on the pool. */
function extractOnPool(pool: ParsePool, text: string, variant: DataVariant = 'json', bom = false): ReturnType<ParsePool['dataRows']> {
  return pool.dataRows(variant, text, Buffer.byteLength(text, 'utf8'), bom);
}

/** Documents covering every column the extractor fills: duplicates, a lossy number, CRLF, an astral key, a scalar root. */
const DOCUMENTS: readonly { text: string; variant: DataVariant; bom: boolean }[] = [
  { text: '{"name": "a", "name": "b", "n": [1, 1.0, -0, 9007199254740993]}', variant: 'json', bom: false },
  { text: '{\r\n  // c\r\n  "\u{1F600}": {"x": null},\r"t": true,\n}', variant: 'jsonc', bom: true },
  { text: '"scalar"', variant: 'json', bom: false },
];

describe('a data extraction on the parse pool', () => {
  it('answers exactly what the extractor computes in-process', async () => {
    const pool = limitedPool();
    for (const { text, variant, bom } of DOCUMENTS) {
      const inProcess = extractDataRows({ text, variant, bom }, TIGHT_LIMITS);
      expect(inProcess.outcome).toBe('rows');
      await expect(extractOnPool(pool, text, variant, bom)).resolves.toStrictEqual(inProcess);
    }
  });

  it('answers a parse error as the document\'s defect, not a rejection', async () => {
    const pool = limitedPool();
    await expect(extractOnPool(pool, '{"a": // no\n1}')).resolves.toStrictEqual({
      outcome: 'defect',
      code: 'DATA_PARSE_ERROR',
      message: 'InvalidCommentToken at line 1, column 7',
    });
  });

  it('is stopped at outputDepth by a 100k-deep array, and the pool still extracts', async () => {
    const pool = limitedPool();
    const depth = 100_000;
    await expect(limitStoppedAt(extractOnPool(pool, `${'['.repeat(depth)}${']'.repeat(depth)}`))).resolves.toBe('outputDepth');
    await expect(extractOnPool(pool, '[1]')).resolves.toMatchObject({ outcome: 'rows' });
  });

  it('is stopped at its row cap over the whole row set', async () => {
    const pool = limitedPool({ outputRows: 4 });
    await expect(limitStoppedAt(extractOnPool(pool, '[1, 2]'))).resolves.toBe('outputRows');
  });

  it('is refused before dispatch when the file is past the input cap', async () => {
    const pool = limitedPool({ inputBytes: 8 });
    await expect(limitStoppedAt(extractOnPool(pool, '[1, 2, 3, 4]'))).resolves.toBe('inputBytes');
  });
});

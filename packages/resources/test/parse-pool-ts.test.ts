/**
 * The `ts` job on the parse pool, through the real built worker: it answers exactly what the
 * extractor computes in-process; it runs under the pool's document output caps (never the data
 * instance's larger ones); nesting past `outputDepth` is refused by the nesting pre-scan before
 * TypeScript recurses; nesting AT `outputDepth`, in every bracket kind and in JSX, parses completely
 * at the configured `stackMb`; and JSX nested past what the stack holds, which the pre-scan does
 * not count, ends in a refusal. The seeded-thread cases (the same deep file with the pre-scan's
 * gate removed, and a thread that dies holding the job) are in `parse-pool.test.ts`, beside the
 * data job's, because a seeded worker entry is a file on disk.
 */

import { describe, expect, it, onTestFinished } from 'vitest';

import { keyContent } from '../src/content-key.js';
import { DEFAULT_PARSE_LIMITS } from '../src/parse-limits.js';
import { createParsePool } from '../src/parse-pool.js';
import { contentRoute } from '../src/projection/document-facts.js';
import { extractTsRows } from '../src/projection/ts-extractor.js';
import type { TsVariant } from '../src/schemas/projection-ts.js';
import { loadVendoredTypeScript } from '../src/vendored-typescript.js';

import {
  answeredRows,
  BRACKET_NESTINGS,
  CONFIGURED_NESTING,
  firstRefusal,
  JSX_NESTING,
  nested,
  settled,
  tsOnPool,
} from './helpers/ts-nesting.js';
import { limitedPools, limitStoppedAt, TIGHT_LIMITS } from './parse-limit-fixtures.js';

const limitedPool = limitedPools();

describe('a ts extraction on the parse pool', () => {
  it('answers exactly what the extractor computes in-process, in every variant', async () => {
    const typescript = await loadVendoredTypeScript();
    const pool = limitedPool();
    const documents: readonly [string, TsVariant][] = [
      ["import a, { b as c } from './a.js';\nexport * from 'pkg';\nconst d = require('d');\n", 'ts'],
      ["import type { T } from './t';\ndeclare module 'm' {}\n", 'dts'],
      ["import React from 'react';\nexport const v = <a b={1}>{[2]}</a>;\n", 'tsx'],
      ["/** @type {import('./x').Y} */\nlet y;\nmodule.exports = y;\n", 'js'],
    ];
    for (const [text, variant] of documents) {
      const inProcess = extractTsRows(typescript, { text, variant }, TIGHT_LIMITS);
      expect(inProcess.outcome).toBe('rows');
      await expect(tsOnPool(pool, text, variant)).resolves.toStrictEqual(inProcess);
    }
  });

  it('answers JSX in a `ts` file as the document\'s TS_PARSE_ERROR, not a rejection', async () => {
    await expect(tsOnPool(limitedPool(), 'export const v = <a />;\n')).resolves.toMatchObject({ outcome: 'defect', code: 'TS_PARSE_ERROR' });
  });

  it('routes a file with a NUL byte as not text, the gate the stage applies before any ts job', () => {
    // The stage decides `BLOB_NOT_TEXT` from the read's decode, so a NUL never reaches the pool.
    const nul = String.fromCodePoint(0);
    expect(contentRoute(keyContent(`export const a = 1;${nul}\n`, 'none')).kind).toBe('not-text');
  });

  it('is refused before dispatch when the file is past the input cap', async () => {
    await expect(limitStoppedAt(tsOnPool(limitedPool({ inputBytes: 8 }), "import './a';\n"))).resolves.toBe('inputBytes');
  });

  it('is stopped at the pool\'s document row cap, not the data instance\'s larger one', async () => {
    // A pool with no cap named: its documents' rows are capped at the default, its data jobs' far higher.
    const pool = createParsePool({ size: 1 });
    onTestFinished(() => pool.shutdown());
    const text = Array.from({ length: DEFAULT_PARSE_LIMITS.outputRows }, (_, index) => `import './m${String(index)}';`).join('\n');
    await expect(limitStoppedAt(tsOnPool(pool, text))).resolves.toBe('outputRows');
  });

  it('refuses nesting past outputDepth at the pre-scan, and the pool still extracts', async () => {
    const pool = limitedPool(CONFIGURED_NESTING);
    for (const nesting of BRACKET_NESTINGS) {
      await expect(limitStoppedAt(tsOnPool(pool, nested(nesting, DEFAULT_PARSE_LIMITS.outputDepth + 1), nesting.variant))).resolves.toBe('outputDepth');
    }
    await expect(tsOnPool(pool, "import './a';\n")).resolves.toMatchObject({ outcome: 'rows' });
  });

  it('parses nesting AT outputDepth completely, in every bracket kind and in JSX, at the configured stack', async () => {
    const pool = limitedPool(CONFIGURED_NESTING);
    for (const nesting of [...BRACKET_NESTINGS, JSX_NESTING]) {
      const answer = await tsOnPool(pool, nested(nesting, DEFAULT_PARSE_LIMITS.outputDepth), nesting.variant);
      expect(answer).toMatchObject({ outcome: 'rows', rows: { files: [{ moduleSyntax: true, hasJsx: nesting.variant === 'tsx' }] } });
    }
  });

  it('ends brackets nested past outputDepth at the depth cap, never at the stack: the first refused depth is the cap\'s', async () => {
    const pool = limitedPool(CONFIGURED_NESTING);
    for (const nesting of BRACKET_NESTINGS) {
      // `firstRefusal` doubles from twice the cap and stops at the first answer that is not rows: were the
      // pre-scan's gate gone, this is the depth at which the stack, not the cap, would end it (the
      // seeded red seed in `parse-pool.test.ts` runs that for parentheses).
      const { depth, outcome } = await firstRefusal((at) => settled(tsOnPool(pool, nested(nesting, at), nesting.variant)));
      expect(depth).toBe(DEFAULT_PARSE_LIMITS.outputDepth * 2);
      expect(outcome).toMatchObject({ code: 'PARSE_LIMIT_EXCEEDED', limit: 'outputDepth' });
    }
  });

  it('refuses JSX nested past what the stack holds, which the pre-scan does not count, as a refusal and never as rows', async () => {
    const pool = limitedPool(CONFIGURED_NESTING);
    // Every depth answered before the refusal is a correct answer, never a recovered one.
    const { outcome } = await firstRefusal(async (depth) => {
      const answer = await settled(tsOnPool(pool, nested(JSX_NESTING, depth), 'tsx'));
      if (answeredRows(answer)) expect(answer).toMatchObject({ rows: { files: [{ hasJsx: true }] } });
      return answer;
    });
    expect(outcome).toMatchObject({ code: 'PARSE_LIMIT_EXCEEDED', limit: 'stackMb' });
  });
});

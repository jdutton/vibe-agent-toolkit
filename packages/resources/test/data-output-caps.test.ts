/**
 * A data-extractor job's own row and byte caps (`dataOutputCaps` in
 * `parse-limits.ts`): a committed JSON Schema document of 23,005 rows and
 * 6.6 MB of rows' JSON, past the document caps on both, is admitted where the
 * caller left the defaults, and one row or one byte cap past the data caps is
 * still refused, in-process and on the pool. The fixtures are generated JSON
 * Schema documents, gzipped (`test/fixtures/data-output-caps/`), recorded in
 * `docs/architecture/fact-extractors-limits.md`.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PARSE_LIMITS, dataOutputCaps, factsOutputSize, isParseLimitError } from '../src/parse-limits.js';
import { extractDataRows } from '../src/projection/data-extractor.js';

import { limitedPools } from './parse-limit-fixtures.js';

const FIXTURES = safePath.join(__dirname, 'fixtures', 'data-output-caps');

/** A committed fixture document's text. */
function fixture(name: string): string {
  return gunzipSync(readFileSync(safePath.join(FIXTURES, `${name}.schema.json.gz`))).toString('utf8');
}

const DATA_CAPS = dataOutputCaps(DEFAULT_PARSE_LIMITS);

/** A JSON array of zeros whose row set is exactly `rows`: its nodes, one file row and one document row. */
function arrayOfRows(rows: number): string {
  return `[${Array.from({ length: rows - 3 }, () => '0').join(',')}]`;
}

/**
 * One wide array under a long key: few rows, each carrying the key in its pointer, so the rows'
 * JSON passes the data byte cap far under the data row cap.
 */
function pastDataBytes(): string {
  return `{"${'k'.repeat(10_000)}": [${Array.from({ length: 7000 }, () => '0').join(',')}]}`;
}

describe('the data output caps', () => {
  it('are their own pair, looser than the document caps, and depth stays shared', () => {
    expect(DATA_CAPS.outputRows).toBeGreaterThan(DEFAULT_PARSE_LIMITS.outputRows);
    expect(DATA_CAPS.outputBytes).toBeGreaterThan(DEFAULT_PARSE_LIMITS.outputBytes);
    expect(DATA_CAPS).toStrictEqual({ outputRows: 262_144, outputBytes: 64 * 1024 * 1024, outputDepth: DEFAULT_PARSE_LIMITS.outputDepth });
  });

  it('keep a cap the caller named, and change nothing when applied twice', () => {
    expect(dataOutputCaps({ outputRows: 4, outputBytes: 64, outputDepth: 3 })).toStrictEqual({ outputRows: 4, outputBytes: 64, outputDepth: 3 });
    expect(dataOutputCaps(DATA_CAPS)).toStrictEqual(DATA_CAPS);
  });
});

describe('extractDataRows under the default limits', () => {
  it('admits a 1.1 MB JSON Schema document of 23,005 rows, past both document caps', () => {
    const extraction = extractDataRows({ text: fixture('contract-large'), variant: 'json', bom: false }, DEFAULT_PARSE_LIMITS);

    expect(extraction.outcome).toBe('rows');
    if (extraction.outcome !== 'rows') return;
    const size = factsOutputSize(extraction.rows);
    expect(size.rows).toBe(23_005);
    expect(size.rows, 'past the document row cap').toBeGreaterThan(DEFAULT_PARSE_LIMITS.outputRows);
    expect(size.bytes, 'past the document byte cap').toBeGreaterThan(DEFAULT_PARSE_LIMITS.outputBytes);
  });

  it('admits a JSON array of exactly the data row cap, and refuses one row past it', () => {
    expect(extractDataRows({ text: arrayOfRows(DATA_CAPS.outputRows), variant: 'json', bom: false }, DEFAULT_PARSE_LIMITS).outcome).toBe('rows');
    expect(extractDataRows({ text: arrayOfRows(DATA_CAPS.outputRows + 1), variant: 'json', bom: false }, DEFAULT_PARSE_LIMITS)).toStrictEqual({
      outcome: 'breach',
      limit: 'outputRows',
      found: DATA_CAPS.outputRows + 1,
    });
  });

  it('refuses rows whose JSON passes the data byte cap under its row cap', () => {
    expect(extractDataRows({ text: pastDataBytes(), variant: 'json', bom: false }, DEFAULT_PARSE_LIMITS)).toMatchObject({
      outcome: 'breach',
      limit: 'outputBytes',
    });
  });
});

describe('a data job on a pool left at the document caps', () => {
  const pool = limitedPools();
  const atDocumentCaps = { timeMs: DEFAULT_PARSE_LIMITS.timeMs, outputRows: DEFAULT_PARSE_LIMITS.outputRows, outputBytes: DEFAULT_PARSE_LIMITS.outputBytes };

  it('admits the 23,005-row document', async () => {
    const text = fixture('contract-large');
    await expect(pool(atDocumentCaps).dataRows('json', text, Buffer.byteLength(text, 'utf8'), false)).resolves.toMatchObject({ outcome: 'rows' });
  });

  it('refuses one row past the data row cap, naming the data cap as its bound', async () => {
    const text = arrayOfRows(DATA_CAPS.outputRows + 1);
    const error: unknown = await pool(atDocumentCaps).dataRows('json', text, Buffer.byteLength(text, 'utf8'), false).then(
      () => new Error('admitted'),
      (rejection: unknown) => rejection,
    );

    expect(isParseLimitError(error)).toBe(true);
    if (!isParseLimitError(error)) return;
    expect(error.limit).toBe('outputRows');
    expect(error.bound).toBe(`${String(DATA_CAPS.outputRows)} output rows; this document has ${String(DATA_CAPS.outputRows + 1)}`);
  });
});

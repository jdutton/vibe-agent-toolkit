/**
 * A data-extractor job's own output caps at their boundaries, in-process and on a real pool: one
 * row and one byte at and past each data cap, a caller-named cap applied to data jobs as named,
 * the worker's per-job output record for data jobs, and a YAML stream the row cap admits read on
 * a small worker stack. Integration, not unit: each boundary builds and serialises tens of
 * megabytes of rows, and the pool cases start real threads.
 */

import * as fs from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { DATA_OUTPUT_CAPS, DEFAULT_PARSE_LIMITS, isParseLimitError, type ParseLimits, resolveDataOutputCaps } from '../../src/parse-limits.js';
import { createParsePool, type ParsePool } from '../../src/parse-pool.js';
import { __readParseTimingSnapshot, __setParseTimingForTest, __writeParseTimingDumpForTest, type ParseTimingDump } from '../../src/parse-timing.js';
import { extractDataRows } from '../../src/projection/data-extractor.js';
import { pastDataBytes } from '../../src/testing/data-cap-fixtures.js';
import { dataCapFixture } from '../helpers/data-cap-fixture.js';
import { stubParkingMachine } from '../test-helpers.js';

/** The caps a data job runs under when its caller names none. */
const DATA_CAPS = resolveDataOutputCaps(undefined);

/** A JSON array of zeros whose row set is exactly `rows`: its nodes, one file row and one document row. */
function arrayOfRows(rows: number): string {
  return `[${Array.from({ length: rows - 3 }, () => '0').join(',')}]`;
}

/** Extract `text` as strict JSON under the caps a data job gets when its caller names none. */
function extractJson(text: string): ReturnType<typeof extractDataRows> {
  return extractDataRows({ text, variant: 'json', bom: false }, DATA_CAPS);
}

/**
 * A document whose rows' JSON is a padded string plus one wide array under a long key, under the
 * data byte cap before any padding (each element's row is about 10,200 bytes: its pointer carries
 * the key). The pad comes last, so it moves no other row's column: each padding character is one
 * byte of its own row's JSON.
 */
function paddedUnderDataBytes(pad: number): string {
  const elements = Math.floor(DATA_CAPS.outputBytes / 10_300);
  return `{"${'k'.repeat(10_000)}": [${Array.from({ length: elements }, () => '0').join(',')}], "pad": "${'x'.repeat(pad)}"}`;
}

/** The rejection a job settled to, or an error saying it was admitted. */
function rejectionOf(job: Promise<unknown>): Promise<unknown> {
  return job.then(() => new Error('admitted'), (rejection: unknown) => rejection);
}

describe('extractDataRows at the data caps', () => {
  it('admits a JSON array of exactly the data row cap, and refuses one row past it', () => {
    expect(extractJson(arrayOfRows(DATA_CAPS.outputRows)).outcome).toBe('rows');
    expect(extractJson(arrayOfRows(DATA_CAPS.outputRows + 1))).toStrictEqual({ outcome: 'breach', limit: 'outputRows', found: DATA_CAPS.outputRows + 1 });
  });

  it('admits rows whose JSON is exactly the data byte cap, and refuses one byte past it', () => {
    const base = extractJson(paddedUnderDataBytes(0));
    if (base.outcome !== 'rows') throw new Error(`the unpadded document was not admitted: ${JSON.stringify(base)}`);
    const pad = DATA_CAPS.outputBytes - base.bytes;

    const atCap = extractJson(paddedUnderDataBytes(pad));
    expect(atCap.outcome === 'rows' ? atCap.bytes : atCap).toBe(DATA_CAPS.outputBytes);
    const pastCap = extractJson(paddedUnderDataBytes(pad + 1));
    expect(pastCap).toStrictEqual({ outcome: 'breach', limit: 'outputBytes', found: DATA_CAPS.outputBytes + 1 });
    // Refused at the data cap, not at the document cap it passed long before.
    expect((pastCap as { found: number }).found).toBeGreaterThan(DEFAULT_PARSE_LIMITS.outputBytes);
  });

  it('refuses the shared past-the-byte-cap fixture at outputBytes, far under the row cap', () => {
    expect(extractJson(pastDataBytes())).toMatchObject({ outcome: 'breach', limit: 'outputBytes' });
  });
});

/** Every pool a test opened, shut down after it. */
const openPools: ParsePool[] = [];

/** A one-thread pool under the defaults with `limits` named over them. */
function poolNaming(limits?: Partial<ParseLimits>): ParsePool {
  const pool = createParsePool(limits === undefined ? { size: 1 } : { size: 1, limits });
  openPools.push(pool);
  return pool;
}

/** A strict JSON data job on `pool`. */
function dataRows(pool: ParsePool, text: string): ReturnType<ParsePool['dataRows']> {
  return pool.dataRows('json', text, Buffer.byteLength(text, 'utf8'), false);
}

describe('a data job on a pool', () => {
  afterEach(async () => {
    await Promise.all(openPools.splice(0, openPools.length).map((pool) => pool.shutdown()));
  });

  it('admits the 23,005-row document when the caller names no cap', async () => {
    await expect(dataRows(poolNaming(), dataCapFixture('contract-large'))).resolves.toMatchObject({ outcome: 'rows', bytes: 6_620_209 });
  });

  it('holds data jobs to a row cap the caller named, even one equal to the document default', async () => {
    const error = await rejectionOf(dataRows(poolNaming({ outputRows: DEFAULT_PARSE_LIMITS.outputRows }), dataCapFixture('contract-large')));
    expect(isParseLimitError(error) ? [error.limit, error.bound] : error).toStrictEqual(['outputRows', '16384 output rows; this document has 23005']);
  });

  it('refuses one row past the data row cap, naming the data cap as its bound', async () => {
    const error = await rejectionOf(dataRows(poolNaming(), arrayOfRows(DATA_CAPS.outputRows + 1)));
    expect(isParseLimitError(error) ? [error.limit, error.bound] : error).toStrictEqual([
      'outputRows',
      `${String(DATA_CAPS.outputRows)} output rows; this document has ${String(DATA_CAPS.outputRows + 1)}`,
    ]);
  });

  it('reads a YAML stream of as many documents as the row cap holds on a 1 MiB worker stack', async () => {
    // 130,000 empty documents: a document row and a node row each, and the file row, under 262,144.
    const text = '---\n'.repeat(130_000);
    const answer = await poolNaming({ stackMb: 1 }).dataRows('yaml', text, Buffer.byteLength(text, 'utf8'), false);
    expect(answer.outcome === 'rows' ? answer.rows.files : answer).toStrictEqual([{ documents: 130_000, bom: false, nodeCount: 130_000, maxDepth: 0 }]);
  });

  it('records, with timing on, what its data jobs measured: the admitted fixture and one refused past the row cap', async () => {
    const directory = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-data-caps-timing-'));
    const previous = process.env['VAT_PARSE_TIMING'];
    // The worker reads the gate at its module load, from the environment it copied at construction.
    process.env['VAT_PARSE_TIMING'] = directory;
    __setParseTimingForTest(directory);
    try {
      stubParkingMachine();
      const pool = createParsePool({ size: 1 });
      await dataRows(pool, dataCapFixture('contract-large'));
      await rejectionOf(dataRows(pool, arrayOfRows(DATA_CAPS.outputRows + 1)));
      await pool.shutdown();

      const dump = JSON.parse(await fs.readFile(__writeParseTimingDumpForTest() ?? '', 'utf8')) as ParseTimingDump;
      const worker = dump.threads.find((thread) => thread.threadId > 0);
      expect(worker?.outputs.find((record) => record.job === 'data')).toStrictEqual({
        job: 'data',
        admitted: 1,
        rowsMax: 23_005,
        bytesMax: 6_620_209,
        depthMax: 6,
        refused: [
          { limit: 'outputRows', jobs: 1, foundMax: DATA_CAPS.outputRows + 1 },
          { limit: 'outputBytes', jobs: 0, foundMax: 0 },
          { limit: 'outputDepth', jobs: 0, foundMax: 0 },
        ],
      });
      // The thread that dispatched ran no data job of its own.
      expect(__readParseTimingSnapshot().outputs.find((record) => record.job === 'data')?.admitted).toBe(0);
    } finally {
      if (previous === undefined) delete process.env['VAT_PARSE_TIMING'];
      else process.env['VAT_PARSE_TIMING'] = previous;
      __setParseTimingForTest(null);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe('the shared byte-cap fixture', () => {
  it('passes the cap it is built against', () => {
    expect(extractDataRows({ text: pastDataBytes(4096), variant: 'json', bom: false }, { ...DATA_OUTPUT_CAPS, outputBytes: 4096, outputDepth: 1000 })).toMatchObject({
      outcome: 'breach',
      limit: 'outputBytes',
    });
  });
});

/**
 * A data-extractor job's own row and byte caps (`resolveDataOutputCaps` in `parse-limits.ts`): which
 * caps a data job runs under for what its caller named, and the committed fixture documents the
 * caps were derived from, pinned so the figures `docs/architecture/fact-extractors-limits.md`
 * records cannot drift from them. The boundary cases and the pool live in
 * `integration/data-output-caps.integration.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { DATA_OUTPUT_CAPS, DEFAULT_PARSE_LIMITS, factsOutputSize, resolveDataOutputCaps } from '../src/parse-limits.js';
import { extractDataRows } from '../src/projection/data-extractor.js';

import { dataCapFixture } from './helpers/data-cap-fixture.js';

describe('resolveDataOutputCaps', () => {
  it('gives a caller that named no cap the data job\'s own row and byte caps, and the shared depth', () => {
    expect(DATA_OUTPUT_CAPS.outputRows).toBeGreaterThan(DEFAULT_PARSE_LIMITS.outputRows);
    expect(DATA_OUTPUT_CAPS.outputBytes).toBeGreaterThan(DEFAULT_PARSE_LIMITS.outputBytes);
    expect(resolveDataOutputCaps(undefined)).toStrictEqual({ outputRows: 262_144, outputBytes: 64 * 1024 * 1024, outputDepth: DEFAULT_PARSE_LIMITS.outputDepth });
    expect(resolveDataOutputCaps({ timeMs: 2000 })).toStrictEqual(resolveDataOutputCaps(undefined));
  });

  it('applies a named row or byte cap to data jobs exactly as named, the other cap left the data job\'s own', () => {
    expect(resolveDataOutputCaps({ outputRows: 20_000 })).toStrictEqual({ outputRows: 20_000, outputBytes: DATA_OUTPUT_CAPS.outputBytes, outputDepth: 1000 });
    expect(resolveDataOutputCaps({ outputBytes: 1024, outputDepth: 3 })).toStrictEqual({ outputRows: DATA_OUTPUT_CAPS.outputRows, outputBytes: 1024, outputDepth: 3 });
  });

  it('reads naming a cap from the caller\'s limits, never from its value: naming the document default is naming it', () => {
    expect(resolveDataOutputCaps({ outputRows: DEFAULT_PARSE_LIMITS.outputRows, outputBytes: DEFAULT_PARSE_LIMITS.outputBytes })).toStrictEqual({
      outputRows: DEFAULT_PARSE_LIMITS.outputRows,
      outputBytes: DEFAULT_PARSE_LIMITS.outputBytes,
      outputDepth: DEFAULT_PARSE_LIMITS.outputDepth,
    });
  });

  it('refuses a named cap resolveParseLimits refuses', () => {
    expect(() => resolveDataOutputCaps({ outputRows: 0 })).toThrow(/outputRows must be a positive finite number/);
  });
});

describe('the fixture documents the data caps were derived from', () => {
  it.each([
    { name: 'contract-large', rows: 23_005, bytes: 6_620_209 },
    { name: 'contract-medium', rows: 12_008, bytes: 3_433_495 },
  ] as const)('$name measures $rows rows, $bytes bytes and depth 6, as the limits record says', ({ name, rows, bytes }) => {
    const extraction = extractDataRows({ text: dataCapFixture(name), variant: 'json', bom: false }, resolveDataOutputCaps(undefined));

    expect(extraction.outcome).toBe('rows');
    if (extraction.outcome !== 'rows') return;
    expect(factsOutputSize(extraction.rows)).toStrictEqual({ rows, bytes, depth: 0 });
    expect(extraction.bytes, 'the bytes the byte cap counted are the record\'s').toBe(bytes);
    expect(extraction.rows.files[0].maxDepth).toBe(6);
  });

  it('the large one passes both document caps, so a caller naming them refuses it at outputRows', () => {
    expect(extractDataRows({ text: dataCapFixture('contract-large'), variant: 'json', bom: false }, DEFAULT_PARSE_LIMITS)).toStrictEqual({
      outcome: 'breach',
      limit: 'outputRows',
      found: 23_005,
    });
  });
});

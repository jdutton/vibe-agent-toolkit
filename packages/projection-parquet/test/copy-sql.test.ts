import { PROJECTION_TABLES, type ProjectionTableName } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PARQUET_COMPRESSION,
  PARQUET_COMPRESSION_CODECS,
  type ParquetCompression,
  buildTableCopySql,
  quotePathLiteral,
} from '../src/copy-sql.js';

/**
 * A COPY statement taken apart again, so an assertion compares the *decoded*
 * identifiers against the registry rather than re-running the same quoting
 * code that produced them.
 */
interface ParsedCopy {
  readonly columns: string[];
  readonly table: string;
  readonly path: string;
  readonly compression: string;
}

const COPY_PATTERN = /^COPY \(SELECT (?<columns>.+) FROM (?<table>".*")\) TO '(?<path>.*)' \(FORMAT parquet, COMPRESSION (?<compression>[a-z0-9_]+)\)$/u;

/**
 * Reverse DuckDB's identifier quoting: strip the outer quotes, un-double the
 * inner ones.
 *
 * @param quoted - A quoted identifier
 * @returns The identifier it stands for
 */
function unquoteIdentifier(quoted: string): string {
  expect(quoted.startsWith('"') && quoted.endsWith('"')).toBe(true);
  return quoted.slice(1, -1).replaceAll('""', '"');
}

/**
 * Take a generated COPY statement apart.
 *
 * @param sql - The statement
 * @returns Its decoded pieces
 */
function parseCopy(sql: string): ParsedCopy {
  const match = COPY_PATTERN.exec(sql);
  expect(match?.groups, `statement did not match the expected COPY shape: ${sql}`).toBeDefined();
  return {
    columns: (match?.groups?.columns ?? '').split(', ').map((column) => unquoteIdentifier(column)),
    table: unquoteIdentifier(match?.groups?.table ?? '""'),
    path: match?.groups?.path ?? '',
    compression: match?.groups?.compression ?? '',
  };
}

const TABLE_NAMES = Object.keys(PROJECTION_TABLES) as ProjectionTableName[];

/** One arbitrary destination, reused so the assertions differ only in what they test. */
const OUTPUT_PATH = '/out/blobs.parquet';

describe('buildTableCopySql', () => {
  it('covers every table the registry declares', () => {
    expect(TABLE_NAMES).toHaveLength(12);
  });

  it.each(TABLE_NAMES)('selects %s in the registry\'s declared column order', (name) => {
    const spec: { readonly name: string; readonly columns: readonly string[] } = PROJECTION_TABLES[name];
    const parsed = parseCopy(buildTableCopySql(name, '/out/table.parquet'));

    expect(parsed.columns).toEqual([...spec.columns]);
    expect(parsed.table).toBe(spec.name);
    expect(parsed.compression).toBe(DEFAULT_PARQUET_COMPRESSION);
  });

  it.each(PARQUET_COMPRESSION_CODECS)('accepts the measured-working codec %s', (compression) => {
    const parsed = parseCopy(buildTableCopySql('blobs', OUTPUT_PATH, { compression }));
    expect(parsed.compression).toBe(compression);
  });

  it('rejects a codec outside the measured-working set rather than interpolating it', () => {
    // `lzo` is a real parquet codec that this engine build does not carry.
    const rejected = 'lzo' as ParquetCompression;
    expect(() => buildTableCopySql('blobs', OUTPUT_PATH, { compression: rejected })).toThrow(RangeError);
    expect(() => buildTableCopySql('blobs', OUTPUT_PATH, { compression: rejected })).toThrow(/lzo/u);
  });

  it('rejects a codec that would smuggle SQL past the FORMAT clause', () => {
    const injected = "zstd) TO '/out/pwned.parquet' (FORMAT parquet" as ParquetCompression;
    expect(() => buildTableCopySql('blobs', OUTPUT_PATH, { compression: injected })).toThrow(RangeError);
  });
});

// `quoteIdentifier` moved to `@vibe-agent-toolkit/resources`, beside the
// registry that mints the names, so both storage backends quote them one way.
// Its tests moved with it.

describe('quotePathLiteral', () => {
  it.each([
    // A single quote would otherwise close the literal and hand the rest to SQL.
    ["/out/o'brien.parquet", "'/out/o''brien.parquet'"],
    ["/out/a'; DROP TABLE blobs; --", "'/out/a''; DROP TABLE blobs; --'"],
    // A backslash inside a DuckDB path literal is a glob escape, not a
    // separator, so it is normalised away even on POSIX — which means a POSIX
    // filename containing a literal backslash is deliberately not addressable.
    [String.raw`/out/we\ird/x.parquet`, "'/out/we/ird/x.parquet'"],
    // A native Windows path is normalised rather than rejected. Measured on
    // POSIX: DuckDB accepts the backslash form and silently creates a file
    // literally named `C:\Users\ci\out.parquet` in the CWD.
    [String.raw`C:\Users\ci\out.parquet`, "'C:/Users/ci/out.parquet'"],
    [String.raw`\\server\share\out.parquet`, "'//server/share/out.parquet'"],
    ['/out/plain.parquet', "'/out/plain.parquet'"],
  ])('escapes %j as %j', (input, expected) => {
    expect(quotePathLiteral(input)).toBe(expected);
  });

  it.each(['', '   '])('rejects the empty path %j', (input) => {
    expect(() => quotePathLiteral(input)).toThrow(RangeError);
  });

  it('escapes the path the same way inside a whole statement', () => {
    const parsed = parseCopy(buildTableCopySql('blobs', String.raw`C:\out\o'brien.parquet`));
    // Still one literal: the doubled quote is what keeps the tail of the path
    // inside it instead of terminating it early.
    expect(parsed.path).toBe("C:/out/o''brien.parquet");
  });
});

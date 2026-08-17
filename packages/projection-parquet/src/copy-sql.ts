/**
 * The `COPY … TO … (FORMAT parquet)` statement that writes one projection
 * table out, built from the registry rather than from a hand-kept list.
 *
 * Nothing here touches DuckDB. The statement is a string, so every escaping
 * rule below is unit-testable without an engine — which matters, because the
 * two traps this module exists to close are both silent.
 */

import { PROJECTION_TABLES, type ProjectionTableName } from '@vibe-agent-toolkit/resources';
import { toForwardSlash } from '@vibe-agent-toolkit/utils';

/**
 * The parquet compression codecs this writer will emit.
 *
 * All seven were exercised against the shipped WASM engine with no network and
 * no extra extension: every one of them writes and reads back. Anything outside
 * this list is rejected rather than interpolated, so a typo becomes an error at
 * the call site instead of a DuckDB parse failure — or, worse, a codec name
 * that happens to parse as something else.
 */
export const PARQUET_COMPRESSION_CODECS = [
  'uncompressed',
  'snappy',
  'gzip',
  'zstd',
  'brotli',
  'lz4',
  'lz4_raw',
] as const;

/** One of the codecs {@link PARQUET_COMPRESSION_CODECS} allows. */
export type ParquetCompression = (typeof PARQUET_COMPRESSION_CODECS)[number];

/**
 * `zstd`, because it measured fastest of the seven at a ratio nothing else
 * beat meaningfully. It is a default, not a constraint: pass `compression` to
 * {@link buildTableCopySql} to pick another.
 */
export const DEFAULT_PARQUET_COMPRESSION: ParquetCompression = 'zstd';

/** How one table's COPY statement should differ from the default. */
export interface CopyOptions {
  /** Codec for the written file. Defaults to {@link DEFAULT_PARQUET_COMPRESSION}. */
  readonly compression?: ParquetCompression;
}

/**
 * Quote a SQL identifier the way DuckDB spells one: double quotes, with any
 * internal double quote doubled.
 *
 * Every table and column name this package emits comes from the registry, so
 * none of them are hostile today. They are quoted anyway, because "the input is
 * trusted" is a property of today's caller and not of the function: an
 * unquoted identifier path is one new column name away from being either a
 * syntax error (a name with a space or a dash) or an injection point.
 *
 * @param identifier - A table or column name
 * @returns The identifier, quoted and escaped for DuckDB
 *
 * @example
 * quoteIdentifier('blob_sections')  // '"blob_sections"'
 * quoteIdentifier('we"ird')         // '"we""ird"'
 */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Quote a filesystem path as a DuckDB string literal.
 *
 * The output path is the one genuinely dangerous input to a COPY statement, and
 * it carries two traps that were measured rather than assumed:
 *
 * 1. **A backslash inside a DuckDB path literal is a glob escape**, not a
 *    directory separator. So a native Windows path is normalised to forward
 *    slashes first, via `toForwardSlash` — the repo-wide helper for exactly
 *    this. DuckDB accepts forward slashes on Windows, including after a drive
 *    letter, so `C:/out/blobs.parquet` is a correct Windows path as well as a
 *    safe literal.
 * 2. **A wrong-platform path is not rejected by DuckDB.** Measured on POSIX:
 *    `COPY … TO 'C:\Users\ci\out.parquet'` *succeeds*, silently creating a file
 *    whose name is that whole string, in the current working directory. There
 *    is no error to catch and nothing at the intended location, so normalising
 *    here is the only place the mistake can be caught at all. We normalise
 *    rather than throw: a caller on Windows passing a Windows path is not
 *    making a mistake, and a caller on POSIX passing `C:\...` gets a path with
 *    a `C:` directory component, which fails loudly on open.
 *
 * A single quote in the path is doubled, or the literal terminates early and
 * the rest of the path becomes SQL.
 *
 * @param outputPath - Where the parquet file should be written
 * @returns The path as a quoted, escaped DuckDB string literal
 * @throws RangeError When the path is empty or only whitespace
 *
 * @example
 * quotePathLiteral('C:\\out\\blobs.parquet')  // "'C:/out/blobs.parquet'"
 * quotePathLiteral("/tmp/o'brien.parquet")    // "'/tmp/o''brien.parquet'"
 */
export function quotePathLiteral(outputPath: string): string {
  if (outputPath.trim() === '') {
    throw new RangeError('A parquet output path cannot be empty');
  }
  return `'${toForwardSlash(outputPath).replaceAll("'", "''")}'`;
}

/**
 * The statement that writes one projection table to a parquet file.
 *
 * The column list is read out of {@link PROJECTION_TABLES} in the order the row
 * schema declares, and is never restated here — a second list would drift from
 * the first, which is the failure the registry exists to prevent. `SELECT *`
 * would avoid the list but not the problem: it would make the written column
 * order whatever the DuckDB table happened to be created with.
 *
 * @param table - Which projection table to write
 * @param outputPath - Where the parquet file should be written
 * @param options - Compression override
 * @returns A complete DuckDB `COPY` statement
 * @throws RangeError When the path is empty, or the compression codec is not
 *   one of {@link PARQUET_COMPRESSION_CODECS}
 *
 * @example
 * buildTableCopySql('blobs', '/out/blobs.parquet');
 * // COPY (SELECT "content_key", … FROM "blobs") TO '/out/blobs.parquet' (FORMAT parquet, COMPRESSION zstd)
 */
export function buildTableCopySql(table: ProjectionTableName, outputPath: string, options: CopyOptions = {}): string {
  const spec: { readonly name: string; readonly columns: readonly string[] } = PROJECTION_TABLES[table];
  const compression = options.compression ?? DEFAULT_PARQUET_COMPRESSION;
  if (!(PARQUET_COMPRESSION_CODECS as readonly string[]).includes(compression)) {
    throw new RangeError(
      `Unsupported parquet compression "${compression}" — expected one of: ${PARQUET_COMPRESSION_CODECS.join(', ')}`,
    );
  }

  const columns = spec.columns.map((column) => quoteIdentifier(column)).join(', ');
  const target = quotePathLiteral(outputPath);
  return `COPY (SELECT ${columns} FROM ${quoteIdentifier(spec.name)}) TO ${target} (FORMAT parquet, COMPRESSION ${compression})`;
}

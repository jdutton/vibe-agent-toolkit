/*
 * `apache-arrow` is imported directly here, which the production code
 * deliberately never lets a *caller* do across the duckdb-wasm seam.
 *
 * That is safe in a test and unsafe in production for one reason: this file and
 * `src/encode.ts` resolve to the same module instance, so an Arrow object built
 * by one is recognised by the other. duckdb-wasm `require`s its own copy —
 * `Arrow.node.js` where we load `Arrow.node.mjs`, two distinct instances of the
 * identical version — and an Arrow object crossing *that* boundary serialises
 * to zero bytes with no error raised. Bytes have no module identity, which is
 * why the encoder's public API is a `Uint8Array` and why this test decodes
 * bytes rather than inspecting anything the encoder returned.
 */

import { PROJECTION_TABLES, type ProjectionRow } from '@vibe-agent-toolkit/resources';
import * as arrow from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type ArrowEncodableTable, encodeArrowStream } from '../src/encode.js';

/** Arrow IPC stream frames open with this continuation marker. */
const STREAM_CONTINUATION = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

/** Arrow IPC *file* frames open with this magic — the format we must not emit. */
const FILE_MAGIC = 'ARROW1';

/**
 * Read the encoded bytes back into plain JS values, one array per column.
 *
 * `Int64` columns decode as `BigInt`; they are narrowed back to `number` so an
 * assertion can compare against the value that went in.
 *
 * @param bytes - Arrow IPC bytes
 * @returns Column name to its decoded values, in row order
 */
function decodeColumns(bytes: Uint8Array): Record<string, unknown[]> {
  const table = arrow.tableFromIPC(bytes);
  const decoded: Record<string, unknown[]> = {};
  for (const field of table.schema.fields) {
    const child = table.getChild(field.name);
    decoded[field.name] = [...(child ?? [])].map((value) => (typeof value === 'bigint' ? Number(value) : value));
  }
  return decoded;
}

/**
 * The Arrow type name each column was given, in schema order.
 *
 * @param bytes - Arrow IPC bytes
 * @returns `name: type` for every field
 */
function decodeFieldTypes(bytes: Uint8Array): string[] {
  return arrow.tableFromIPC(bytes).schema.fields.map((field) => `${field.name}: ${String(field.type)}`);
}

/**
 * A table that is not one of the twelve, so that every Arrow type this encoder
 * can produce has a column exercising it — including `Float64`, which no
 * projection column happens to use today, and `Timestamp`, which only one does.
 */
const MIXED_TABLE = {
  columns: ['label', 'ratio', 'count', 'flag', 'stamp', 'payload'],
  schema: z.object({
    label: z.string().nullable(),
    ratio: z.number(),
    count: z.number().int(),
    flag: z.boolean().nullable(),
    stamp: z.coerce.date().nullable(),
    payload: z.record(z.string(), z.unknown()).nullable(),
  }),
} satisfies ArrowEncodableTable<{
  label: string | null;
  ratio: number;
  count: number;
  flag: boolean | null;
  stamp: Date | null;
  payload: Record<string, unknown> | null;
}>;

/** A string carrying every byte class the two text ingest routes would escape. */
const HOSTILE_TEXT = 'quote " comma , newline \n backslash \\ unicode ünïçø∂é 🎯 tab \t';

const MIXED_ROWS = [
  {
    label: 'first',
    ratio: 1.5,
    count: 7,
    flag: true,
    stamp: new Date(1_700_000_000_000),
    payload: { nested: { deep: [1, 'two', false, null] }, ratio: 0.125 },
  },
  { label: '', ratio: -0.25, count: -1, flag: false, stamp: new Date(0), payload: {} },
  { label: HOSTILE_TEXT, ratio: 0, count: 9_007_199_254_740_991, flag: null, stamp: null, payload: null },
  { label: null, ratio: Number.MAX_SAFE_INTEGER, count: 0, flag: true, stamp: new Date(86_400_000), payload: { a: 1 } },
];

describe('encodeArrowStream', () => {
  it('emits the stream format, never the file format', () => {
    const { bytes } = encodeArrowStream(MIXED_TABLE, MIXED_ROWS);

    // The pin is on the bytes, not on the intent: `tableFromIPC` reads BOTH
    // formats, so a decode-only assertion cannot tell them apart — while
    // duckdb-wasm's `insertArrowFromIPCStream` silently no-ops on the file
    // format and poisons the connection for every insert after it.
    expect(bytes.slice(0, STREAM_CONTINUATION.length)).toEqual(STREAM_CONTINUATION);
    expect(new TextDecoder().decode(bytes.slice(0, FILE_MAGIC.length))).not.toBe(FILE_MAGIC);
  });

  it('returns non-empty bytes and the row count that went in', () => {
    const { bytes, rowCount } = encodeArrowStream(MIXED_TABLE, MIXED_ROWS);

    expect(bytes.length).toBeGreaterThan(0);
    expect(rowCount).toBe(MIXED_ROWS.length);
    expect(arrow.tableFromIPC(bytes).numRows).toBe(rowCount);
  });

  it('round-trips nulls, empty strings, hostile text, integers, floats, booleans and nested JSON', () => {
    const { bytes } = encodeArrowStream(MIXED_TABLE, MIXED_ROWS);
    const decoded = decodeColumns(bytes);

    expect(decoded['label']).toEqual(['first', '', HOSTILE_TEXT, null]);
    expect(decoded['ratio']).toEqual([1.5, -0.25, 0, Number.MAX_SAFE_INTEGER]);
    expect(decoded['count']).toEqual([7, -1, 9_007_199_254_740_991, 0]);
    expect(decoded['flag']).toEqual([true, false, null, true]);
    expect(decoded['stamp']).toEqual([1_700_000_000_000, 0, null, 86_400_000]);
    // Nested JSON is VARCHAR, so it comes back as the exact JSON text — no
    // struct was inferred from a sample and no key was dropped.
    expect((decoded['payload'] ?? []).map((cell) => (cell === null ? null : JSON.parse(cell as string)))).toEqual([
      MIXED_ROWS[0]?.payload,
      MIXED_ROWS[1]?.payload,
      null,
      MIXED_ROWS[3]?.payload,
    ]);
  });

  it('derives an Arrow type per column from the Zod schema', () => {
    const { bytes } = encodeArrowStream(MIXED_TABLE, MIXED_ROWS);

    expect(decodeFieldTypes(bytes)).toEqual([
      'label: Utf8',
      'ratio: Float64',
      'count: Int64',
      'flag: Bool',
      'stamp: Timestamp<MILLISECOND>',
      'payload: Utf8',
    ]);
  });

  it('encodes zero rows as a schema-only stream rather than nothing at all', () => {
    const { bytes, rowCount } = encodeArrowStream(MIXED_TABLE, []);

    expect(rowCount).toBe(0);
    expect(bytes.length).toBeGreaterThan(0);
    expect(arrow.tableFromIPC(bytes).numRows).toBe(0);
    expect(decodeFieldTypes(bytes)).toHaveLength(MIXED_TABLE.columns.length);
  });

  it('refuses a column the row schema does not declare', () => {
    const bogus = { columns: ['nope'], schema: z.object({ real: z.string() }) } as unknown as ArrowEncodableTable<{
      nope: string;
    }>;

    expect(() => encodeArrowStream(bogus, [{ nope: 'x' }])).toThrow(TypeError);
  });

  it('refuses a Zod type no storage backend has a representation for', () => {
    const unsupported = {
      columns: ['blob'],
      schema: z.object({ blob: z.instanceof(Uint8Array) }),
    } as unknown as ArrowEncodableTable<{ blob: Uint8Array }>;

    expect(() => encodeArrowStream(unsupported, [{ blob: new Uint8Array([1]) }])).toThrow(/no storage representation/u);
  });
});

describe('encodeArrowStream over the registry', () => {
  const blobRows: ProjectionRow<'blobs'>[] = [
    {
      contentKey: 'markdown.'.padEnd(9, '') + 'a'.repeat(64),
      bytes: 1024,
      tokenEstimate: 256,
      frontmatter: { title: 'Doc "one"', tags: ['a', 'b'], nested: { depth: 2 }, ratio: 1.5 },
      frontmatterError: null,
      wordCount: 180,
      proseBytes: 900,
      codeBlockBytes: 124,
      linkCount: 3,
      headingCount: 4,
      sectionCount: 4,
    },
    {
      contentKey: 'html.' + 'b'.repeat(64),
      bytes: 0,
      tokenEstimate: 0,
      frontmatter: null,
      frontmatterError: 'frontmatter is not a mapping',
      wordCount: 0,
      proseBytes: 0,
      codeBlockBytes: 0,
      linkCount: 0,
      headingCount: 0,
      sectionCount: 0,
    },
  ];

  it('uses the registry column order for the Arrow schema', () => {
    const { bytes, rowCount } = encodeArrowStream(PROJECTION_TABLES.blobs, blobRows);
    const names = arrow.tableFromIPC(bytes).schema.fields.map((field) => field.name);

    expect(names).toEqual([...PROJECTION_TABLES.blobs.columns]);
    expect(rowCount).toBe(blobRows.length);
  });

  it('carries a real frontmatter object through as JSON text', () => {
    const { bytes } = encodeArrowStream(PROJECTION_TABLES.blobs, blobRows);
    const decoded = decodeColumns(bytes);

    expect(decoded['frontmatter']).toEqual([JSON.stringify(blobRows[0]?.frontmatter), null]);
    expect(decoded['bytes']).toEqual([1024, 0]);
    expect(decoded['frontmatterError']).toEqual([null, 'frontmatter is not a mapping']);
  });

  it.each(Object.values(PROJECTION_TABLES).map((spec) => spec.name))(
    'encodes an empty %s with every declared column present',
    (name) => {
      const spec = Object.values(PROJECTION_TABLES).find((candidate) => candidate.name === name);
      const { bytes, rowCount } = encodeArrowStream(
        spec as ArrowEncodableTable<Record<string, unknown>>,
        [],
      );

      expect(rowCount).toBe(0);
      expect(bytes.length).toBeGreaterThan(0);
      expect(arrow.tableFromIPC(bytes).schema.fields.map((field) => field.name)).toEqual([...(spec?.columns ?? [])]);
    },
  );
});

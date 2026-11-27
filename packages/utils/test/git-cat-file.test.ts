/**
 * The one reader of `git cat-file` output: a `--batch` record framed by its byte count, a
 * header-only record, and a `--batch-check` line. Pure: every stream here is written byte for byte.
 */

import { describe, expect, it } from 'vitest';

import { batchCheckOf, frameBatchCheckRecord, frameBatchRecord, parseBatchHeader } from '../src/git-cat-file.js';

const SHA1 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);

/** One honest `--batch` record. */
function record(oid: string, body: Uint8Array | string, type = 'blob'): Buffer {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  return Buffer.concat([Buffer.from(`${oid} ${type} ${bytes.length.toString()}\n`), bytes, Buffer.from('\n')]);
}

describe('parseBatchHeader', () => {
  it.for([
    [`${SHA1} blob 12`, { kind: 'object', oid: SHA1, type: 'blob', size: 12 }],
    [`${SHA256} tree 0`, { kind: 'object', oid: SHA256, type: 'tree', size: 0 }],
    [`${SHA1} missing`, { kind: 'missing', oid: SHA1 }],
  ] as const)('reads %s', ([header, expected]) => {
    expect(parseBatchHeader(Buffer.from(header))).toStrictEqual(expected);
  });

  it.for([
    [`${SHA1} blob +8`, 'a size spelled loosely'],
    [`${SHA1} blob 08`, 'a size with a leading zero'],
    [`${'a'.repeat(39)} blob 8`, 'an object name of another length'],
    [`${SHA1} blob`, 'no size'],
    [`${SHA1} ambiguous`, 'an answer other than missing'],
    [`${SHA1.toUpperCase()} blob 8`, 'upper-case hex'],
  ] as const)('refuses %s (%s)', ([header]) => {
    expect(parseBatchHeader(Buffer.from(header))).toBeUndefined();
  });
});

describe('frameBatchRecord', () => {
  it('frames an object by its byte count, NUL, CR and invalid UTF-8 included', () => {
    const body = Uint8Array.of(0x00, 0x0d, 0x0a, 0xff, 0x0a);
    const stream = Buffer.concat([record(SHA1, body), record(SHA256, 'next')]);
    const first = frameBatchRecord(stream, 0);
    expect(first).toMatchObject({ kind: 'object', oid: SHA1, type: 'blob' });
    if (first.kind !== 'object') throw new Error('unreachable');
    expect([...first.body]).toStrictEqual([...body]);
    expect(frameBatchRecord(stream, first.next)).toMatchObject({ kind: 'object', oid: SHA256, next: stream.length });
  });

  it('reads a missing object as its own record and moves past it', () => {
    const stream = Buffer.concat([Buffer.from(`${SHA1} missing\n`), record(SHA256, 'x')]);
    const missing = frameBatchRecord(stream, 0);
    expect(missing).toStrictEqual({ kind: 'missing', oid: SHA1, next: SHA1.length + 9 });
    expect(frameBatchRecord(stream, missing.kind === 'missing' ? missing.next : -1)).toMatchObject({ kind: 'object', oid: SHA256 });
  });

  it('says the header is not there yet when no LF ends it', () => {
    expect(frameBatchRecord(Buffer.from(`${SHA1} blob 3`), 0)).toStrictEqual({ kind: 'header-incomplete' });
  });

  it('says the body is short when the bytes end before the header says, and how many it needs', () => {
    expect(frameBatchRecord(Buffer.from(`${SHA1} blob 9\nSKILL`), 0)).toStrictEqual({ kind: 'body-incomplete', needed: `${SHA1} blob 9\n`.length + 9 + 1 });
  });

  it('refuses a body whose LF is not where its header says', () => {
    expect(frameBatchRecord(Buffer.from(`${SHA1} blob 2\nokX`), 0)).toMatchObject({ kind: 'unterminated', oid: SHA1 });
  });

  it('refuses a header it cannot read, handing back the header bytes', () => {
    const framed = frameBatchRecord(Buffer.from(`${SHA1} blob +2\nok\n`), 0);
    expect(framed.kind).toBe('malformed-header');
    expect(framed.kind === 'malformed-header' && framed.header.toString()).toBe(`${SHA1} blob +2`);
  });
});

describe('frameBatchCheckRecord', () => {
  it('frames header-only records in a row: an object\'s type and size, then missing', () => {
    const stream = Buffer.from(`${SHA1} blob 5\n${SHA256} missing\n`);
    const first = frameBatchCheckRecord(stream, 0);
    expect(first).toStrictEqual({ kind: 'info', oid: SHA1, type: 'blob', size: 5, next: `${SHA1} blob 5\n`.length });
    expect(frameBatchCheckRecord(stream, first.kind === 'info' ? first.next : -1)).toStrictEqual({ kind: 'missing', oid: SHA256, next: stream.length });
  });

  it('waits for a header with no LF yet, and refuses one it cannot read', () => {
    expect(frameBatchCheckRecord(Buffer.from(`${SHA1} blob 5`), 0)).toStrictEqual({ kind: 'header-incomplete' });
    const framed = frameBatchCheckRecord(Buffer.from(`${SHA1} blob +5\n`), 0);
    expect(framed.kind === 'malformed-header' && framed.header.toString()).toBe(`${SHA1} blob +5`);
  });
});

describe('batchCheckOf', () => {
  it('reads every line: an object\'s type and size, or missing', () => {
    const checked = batchCheckOf(Buffer.from(`${SHA1} blob 5\n${SHA256} missing\n`));
    expect(checked).toStrictEqual(new Map<string, unknown>([
      [SHA1, { kind: 'object', oid: SHA1, type: 'blob', size: 5 }],
      [SHA256, { kind: 'missing', oid: SHA256 }],
    ]));
  });

  it('refuses a listing holding a line it cannot read, or one cut short of its LF', () => {
    expect(batchCheckOf(Buffer.from(`${SHA1} blob five\n`))).toBeUndefined();
    expect(batchCheckOf(Buffer.from(`${SHA1} blob 5`))).toBeUndefined();
  });

  it('reads an empty listing as no objects', () => {
    expect(batchCheckOf(Buffer.alloc(0))).toStrictEqual(new Map());
  });
});

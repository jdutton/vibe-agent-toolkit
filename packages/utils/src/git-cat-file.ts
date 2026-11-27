/**
 * The one reader of `git cat-file` output, for every caller that asks git for objects: the Git LFS
 * pass (`git-lfs.ts`), the clone's committed link texts (agent-skills `git-clone.ts`) and the
 * long-lived object reader (`git-object-reader.ts`).
 *
 * `--batch` (and `--batch-command`'s `contents`) writes, per object asked, `<oid> SP <type> SP
 * <size> LF`, exactly `<size>` bytes, then LF; or `<name> SP missing LF` for an object it does not
 * have. `--batch-check` (and `--batch-command`'s `info`) writes the header line alone. The body is framed by its byte count, never by searching for a LF, so a blob holding
 * NUL, CR, LF or bytes that are not UTF-8 cannot shift the framing (a blob can never plant the next
 * header). Pure: no git runs here.
 */

import { decodeUtf8Exactly } from './text-content.js';

/** LF, which ends every header and every body. */
const LF = 0x0a;

/**
 * An object header: a 40- or 64-hex object name (SHA-1 or SHA-256), its type, and its size in
 * canonical decimal (no sign, no leading zero).
 */
const OBJECT_HEADER = /^([\da-f]{40}|[\da-f]{64}) (blob|tree|commit|tag) (0|[1-9]\d*)$/;

/** git's answer for a name it holds no object for. */
const MISSING_HEADER = /^(\S+) missing$/;

/** One header line, read. */
export type BatchHeader =
  | { readonly kind: 'object'; readonly oid: string; readonly type: string; readonly size: number }
  | { readonly kind: 'missing'; readonly oid: string };

/**
 * Read one header line, its LF already cut.
 *
 * @param header - The line's bytes
 * @returns The header, or `undefined` for a line that is neither an object's nor `missing`
 */
export function parseBatchHeader(header: Uint8Array): BatchHeader | undefined {
  // git writes the header in ASCII; a header that is not even UTF-8 is no header.
  const text = decodeUtf8Exactly(header);
  if (text === undefined) return undefined;
  const object = OBJECT_HEADER.exec(text);
  if (object !== null) {
    const size = Number(object[3]);
    if (!Number.isSafeInteger(size)) return undefined;
    return { kind: 'object', oid: object[1] ?? '', type: object[2] ?? '', size };
  }
  const missing = MISSING_HEADER.exec(text);
  return missing === null ? undefined : { kind: 'missing', oid: missing[1] ?? '' };
}

/** What the `--batch` stream holds at one offset. */
export type BatchFrame =
  /** A whole object; `next` is the offset of the record after it. */
  | { readonly kind: 'object'; readonly oid: string; readonly type: string; readonly body: Buffer; readonly next: number }
  /** An object git does not have. */
  | { readonly kind: 'missing'; readonly oid: string; readonly next: number }
  /** No LF ends the header yet: a stream still arriving, or one cut short. */
  | { readonly kind: 'header-incomplete' }
  /** The body ends before its header says; `needed` is the offset the whole record ends at. */
  | { readonly kind: 'body-incomplete'; readonly needed: number }
  /** A header that is neither an object's nor `missing`. */
  | { readonly kind: 'malformed-header'; readonly header: Buffer }
  /** The byte after the body is not the LF the header's size puts there. */
  | { readonly kind: 'unterminated'; readonly oid: string };

/**
 * Frame the `--batch` record at `at`.
 *
 * @param bytes - The stream, byte for byte
 * @param at - Where the record starts
 * @returns The record, or why there is not a whole one there
 */
export function frameBatchRecord(bytes: Buffer, at: number): BatchFrame {
  const header = frameBatchCheckRecord(bytes, at);
  if (header.kind !== 'info') return header;
  const end = header.next + header.size;
  if (end >= bytes.length) return { kind: 'body-incomplete', needed: end + 1 };
  if (bytes[end] !== LF) return { kind: 'unterminated', oid: header.oid };
  return { kind: 'object', oid: header.oid, type: header.type, body: bytes.subarray(header.next, end), next: end + 1 };
}

/** What a header-only stream (`--batch-check`, `--batch-command`'s `info`) holds at one offset. */
export type BatchCheckFrame =
  /** An object's header; `next` is the offset of the record after it. */
  | { readonly kind: 'info'; readonly oid: string; readonly type: string; readonly size: number; readonly next: number }
  /** An object git does not have. */
  | { readonly kind: 'missing'; readonly oid: string; readonly next: number }
  /** No LF ends the header yet: a stream still arriving, or one cut short. */
  | { readonly kind: 'header-incomplete' }
  /** A header that is neither an object's nor `missing`. */
  | { readonly kind: 'malformed-header'; readonly header: Buffer };

/**
 * Frame the header-only record at `at`.
 *
 * @param bytes - The stream, byte for byte
 * @param at - Where the record starts
 * @returns The record, or why there is not a whole one there
 */
export function frameBatchCheckRecord(bytes: Buffer, at: number): BatchCheckFrame {
  const headerEnd = bytes.indexOf(LF, at);
  if (headerEnd === -1) return { kind: 'header-incomplete' };
  const headerBytes = bytes.subarray(at, headerEnd);
  const header = parseBatchHeader(headerBytes);
  if (header === undefined) return { kind: 'malformed-header', header: headerBytes };
  if (header.kind === 'missing') return { kind: 'missing', oid: header.oid, next: headerEnd + 1 };
  return { kind: 'info', oid: header.oid, type: header.type, size: header.size, next: headerEnd + 1 };
}

/**
 * Read a whole `--batch-check` listing: one header line per name asked.
 *
 * @param bytes - The listing, byte for byte
 * @returns Each line's header by the name it answers, or `undefined` when a line is not a header or
 *   the listing does not end in LF (cut short)
 */
export function batchCheckOf(bytes: Uint8Array): Map<string, BatchHeader> | undefined {
  const checked = new Map<string, BatchHeader>();
  if (bytes.length === 0) return checked;
  if (bytes.at(-1) !== LF) return undefined;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at < buffer.length) {
    const end = buffer.indexOf(LF, at);
    const header = parseBatchHeader(buffer.subarray(at, end));
    if (header === undefined) return undefined;
    checked.set(header.oid, header);
    at = end + 1;
  }
  return checked;
}

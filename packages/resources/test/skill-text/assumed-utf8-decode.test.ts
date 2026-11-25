/**
 * The decoding a stored document reports (`StoredDocumentFacts.decoding`) as
 * `utf-8` / `assumed` is the decode a plain `readFileSync(path, 'utf8')` does:
 * a lane that read the raw file text before the store served it may take the
 * stored record in its place for exactly that pair. Held over invalid byte
 * runs, where both substitute U+FFFD, and over every case a byte-order mark
 * would decide instead.
 */

import { decodeTextContent } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

/** Byte strings with no byte-order mark: clean, malformed, truncated, overlong, surrogate, a mid-file BOM. */
const BOMLESS: readonly (readonly number[])[] = [
  [0x23, 0x20, 0x54, 0x69, 0x74, 0x6c, 0x65, 0x0a],
  [0xff],
  [0x61, 0xff, 0xfe, 0x62],
  [0xc0, 0x80],
  [0xe0, 0x80, 0x80],
  [0xed, 0xa0, 0x80],
  [0xf4, 0x90, 0x80, 0x80],
  [0xf0, 0x9f, 0x98],
  [0x61, 0xe2, 0x82],
  [0xe2, 0x28, 0xa1],
  [0xf8, 0x88, 0x80, 0x80, 0x80],
  [0xef, 0xbf, 0xbd],
  [0xef, 0xbb],
  [0x61, 0xef, 0xbb, 0xbf],
  [0x80, 0x80, 0x80],
  [0x00, 0x61, 0x0d, 0x0a],
];

/** Byte strings a byte-order mark decides: never `utf-8` / `assumed`. */
const BOMMED: readonly (readonly number[])[] = [
  [0xef, 0xbb, 0xbf, 0x61],
  [0xff, 0xfe, 0x61, 0x00],
  [0xfe, 0xff, 0x00, 0x61],
  [0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00],
  [0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x61],
];

describe('a BOM-less decode is a plain UTF-8 read', () => {
  it.each(BOMLESS.map((bytes) => [Buffer.from(bytes).toString('hex'), bytes] as const))('%s', (_hex, bytes) => {
    const buffer = Buffer.from(bytes);
    const decoded = decodeTextContent(buffer);
    expect({ encoding: decoded.encoding, encodingSource: decoded.encodingSource }).toEqual({ encoding: 'utf-8', encodingSource: 'assumed' });
    expect(decoded.text).toBe(buffer.toString('utf8'));
  });

  it.each(BOMMED.map((bytes) => [Buffer.from(bytes).toString('hex'), bytes] as const))('%s is decided by its BOM, never assumed', (_hex, bytes) => {
    expect(decodeTextContent(Buffer.from(bytes)).encodingSource).toBe('bom');
  });
});

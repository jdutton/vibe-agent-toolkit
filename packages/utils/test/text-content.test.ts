/**
 * The canonical content-decoding seam, exercised over raw bytes.
 *
 * `decodeTextContent` is a `utils` primitive rather than a `resources` one, and
 * this suite is where that placement is paid for: nothing here needs a content
 * key, a parse cache or a projection. The end-to-end proof that the projection
 * consumes it lives in `packages/resources/test/system/git-hostile-config
 * .system.test.ts`.
 *
 * Every case here is expressed as the bytes a file would hold, never as a string
 * this test decoded for itself: a case authored as `Buffer.from(s, 'utf16le')`
 * asserted against `buf.toString('utf16le')` would pass whatever
 * `decodeTextContent` did, which is the failure mode a decoder suite is most
 * prone to.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { normalizedTmpdir } from '../src/path-utils.js';
import { safePath } from '../src/path.js';
import { decodeTextContent, type TextEncoding } from '../src/text-content.js';
import { readTextContent, readTextContentSync } from '../src/text-file.js';

/** One heading and one link — enough that a wrong decode cannot parse as markdown. */
const DOC = '# Doc\n\n[b](./b.md)\n';

/** U+FEFF, as a string. Written as an escape: a literal BOM in source is invisible. */
const ZERO_WIDTH_NO_BREAK_SPACE = '\u{FEFF}';

/** U+FFFD, as a string. Written as an escape for the same reason. */
const REPLACEMENT = '\u{FFFD}';

/** U+0000, as a string. A literal NUL in source makes git treat the file as binary. */
const NUL = '\u{0}';

/** Every encoding the seam recognises, and the BOM that announces it. */
const BOM: Record<TextEncoding, readonly number[]> = {
  'utf-8': [0xef, 0xbb, 0xbf],
  'utf-16le': [0xff, 0xfe],
  'utf-16be': [0xfe, 0xff],
  'utf-32le': [0xff, 0xfe, 0x00, 0x00],
  'utf-32be': [0x00, 0x00, 0xfe, 0xff],
};

/** Every encoding the seam recognises, for `it.each` and cross-encoding loops. */
const ALL_ENCODINGS: readonly TextEncoding[] = [
  'utf-8',
  'utf-16le',
  'utf-16be',
  'utf-32le',
  'utf-32be',
];

/** Byte-swap every 16-bit unit — LE bytes become BE bytes. */
function swap16(source: Buffer): Buffer {
  const out = Buffer.from(source);
  out.swap16();
  return out;
}

/** Encode `text` as UTF-32, one 4-byte unit per code point. */
function utf32(text: string, littleEndian: boolean): Buffer {
  const points = [...text];
  const out = Buffer.alloc(points.length * 4);
  for (const [index, point] of points.entries()) {
    out.writeUInt32LE(point.codePointAt(0) ?? 0, index * 4);
  }
  if (!littleEndian) out.swap32();
  return out;
}

/** Encode `text` in `encoding`, with no BOM. */
function body(text: string, encoding: TextEncoding): Buffer {
  switch (encoding) {
    case 'utf-8': {
      return Buffer.from(text, 'utf-8');
    }
    case 'utf-16le': {
      return Buffer.from(text, 'utf16le');
    }
    case 'utf-16be': {
      return swap16(Buffer.from(text, 'utf16le'));
    }
    case 'utf-32le':
    case 'utf-32be': {
      return utf32(text, encoding === 'utf-32le');
    }
  }
}

/** Encode `text` in `encoding`, with the matching BOM in front. */
function withBom(text: string, encoding: TextEncoding): Buffer {
  return Buffer.concat([Buffer.from(BOM[encoding]), body(text, encoding)]);
}

/** One little-endian 32-bit unit. */
function u32le(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

describe('decodeTextContent — what a BOM makes a fact', () => {
  it.each(ALL_ENCODINGS)(
    'decodes a %s document announced by its BOM, and strips the BOM',
    (encoding) => {
      const decoded = decodeTextContent(withBom(DOC, encoding));
      expect(decoded.text).toBe(DOC);
      expect(decoded.encoding).toBe(encoding);
      expect(decoded.basis).toBe('bom');
      // The BOM must not survive into the content: a leading U+FEFF stops
      // `# Doc` from parsing as a heading at all.
      expect(decoded.text.startsWith(ZERO_WIDTH_NO_BREAK_SPACE)).toBe(false);
      expect(decoded.text.startsWith('# ')).toBe(true);
    },
  );

  it('reads a UTF-32LE BOM as UTF-32 and not as the UTF-16LE BOM it starts with', () => {
    // The UTF-32LE BOM `ff fe 00 00` STARTS WITH the UTF-16LE BOM `ff fe`.
    // Testing the two-byte BOM first decodes every UTF-32LE document as
    // NUL-interleaved UTF-16 — the same class of bug as decoding UTF-16 as
    // UTF-8, one encoding further down.
    const bytes = withBom(DOC, 'utf-32le');
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(decodeTextContent(bytes).encoding).toBe('utf-32le');
    expect(decodeTextContent(bytes).text).toBe(DOC);
  });

  it('reads a UTF-32BE document whose first bytes are NUL', () => {
    // `00 00 fe ff`. A leading NUL is exactly what the projection's binary
    // sniff keys on, so this is the one BOM whose document would otherwise be
    // refused as binary before anything looked at it.
    const bytes = withBom(DOC, 'utf-32be');
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x00, 0x00]));
    expect(decodeTextContent(bytes).text).toBe(DOC);
    expect(decodeTextContent(bytes).text).not.toContain(NUL);
  });

  it('carries astral code points through every BOM-announced encoding', () => {
    // A surrogate pair in UTF-16, a single unit in UTF-32 — the case that
    // separates a real conversion from a byte shuffle.
    const astral = 'a\u{1F600}b';
    for (const encoding of ALL_ENCODINGS) {
      expect(decodeTextContent(withBom(astral, encoding)).text, encoding).toBe(astral);
    }
  });
});

describe('decodeTextContent — what it assumes when nothing says', () => {
  it('assumes UTF-8 for BOM-less bytes, and says so', () => {
    const decoded = decodeTextContent(Buffer.from(DOC, 'utf-8'));
    expect(decoded.text).toBe(DOC);
    expect(decoded.encoding).toBe('utf-8');
    expect(decoded.basis).toBe('assumed');
  });

  it('decodes an empty file to an empty string, not to a failure', () => {
    const decoded = decodeTextContent(new Uint8Array());
    expect(decoded.text).toBe('');
    expect(decoded.encoding).toBe('utf-8');
    expect(decoded.basis).toBe('assumed');
  });

  it('does NOT detect BOM-less UTF-16 — a recorded limitation, pinned so it cannot be claimed', () => {
    // BOM-less UTF-16 is undecidable from bytes alone: the same byte string is
    // a legal, different UTF-8 document. This asserts the LIMITATION, so a
    // later heuristic has to change a test that states what it gives up.
    const decoded = decodeTextContent(body(DOC, 'utf-16le'));
    expect(decoded.encoding).toBe('utf-8');
    expect(decoded.basis).toBe('assumed');
    expect(decoded.text).toContain(NUL);
  });

  it('replaces malformed UTF-8 rather than guessing a latin charset', () => {
    // Deliberately NOT a windows-1252 fallback. "These bytes are not UTF-8" is
    // a fact, but "therefore they are latin-1" is a guess, and it is equally
    // consistent with a UTF-8 document carrying one corrupt byte. All three
    // decode to U+FFFD, which is why the content KEY is over raw bytes.
    for (const invalid of [[0xc2], [0xe2, 0x82], [0xff]]) {
      expect(decodeTextContent(Uint8Array.from(invalid)).text).toBe(REPLACEMENT);
    }
  });

  it('keeps a lone trailing byte from derailing a UTF-32 decode', () => {
    const truncated = Buffer.concat([withBom('ab', 'utf-32le'), Buffer.from([0x41])]);
    const decoded = decodeTextContent(truncated);
    expect(decoded.encoding).toBe('utf-32le');
    expect(decoded.text).toBe(`ab${REPLACEMENT}`);
  });

  it('replaces a UTF-32 unit that is not a Unicode scalar value', () => {
    // 0x110000 is past the last code point; 0xD800 is a lone surrogate. Both
    // throw out of `String.fromCodePoint`, which must not be how a corrupt
    // document surfaces.
    const bytes = Buffer.concat([
      Buffer.from(BOM['utf-32le']),
      u32le(0x41),
      u32le(0x11_0000),
      u32le(0xd800),
      u32le(0x42),
    ]);
    expect(decodeTextContent(bytes).text).toBe(`A${REPLACEMENT}${REPLACEMENT}B`);
  });

  it('decodes a document longer than one fromCodePoint call can take', () => {
    // The UTF-32 path builds code points and spreads them into
    // `String.fromCodePoint`, which blows the argument limit somewhere in the
    // tens of thousands. A chunked implementation is the only one that survives
    // this, and nothing smaller than a real document would notice.
    const long = 'x'.repeat(300_000);
    expect(decodeTextContent(withBom(long, 'utf-32le')).text).toBe(long);
  });
});

/** Temp directory the disk-backed cases plant fixtures in. */
let dir = '';

/** Write `bytes` to a fresh file under {@link dir} and hand back its path. */
function plant(name: string, bytes: Buffer): string {
  const file = safePath.join(dir, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp fixture this test created
  writeFileSync(file, bytes);
  return file;
}

describe('readTextContent reads through the same seam', () => {
  beforeAll(() => {
    dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-text-content-'));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('decodes a UTF-16BE file from disk, asynchronously', async () => {
    const decoded = await readTextContent(plant('be.md', withBom(DOC, 'utf-16be')));
    expect(decoded.text).toBe(DOC);
    expect(decoded.encoding).toBe('utf-16be');
  });

  it('decodes a UTF-16LE file from disk, synchronously', () => {
    const decoded = readTextContentSync(plant('le.md', withBom(DOC, 'utf-16le')));
    expect(decoded.text).toBe(DOC);
    expect(decoded.encoding).toBe('utf-16le');
  });

  it('agrees with decodeTextContent on the same bytes, both ways', async () => {
    // The readers must be the seam plus a `readFile`, never a second decoder.
    const bytes = withBom(DOC, 'utf-32be');
    const file = plant('agree.md', bytes);
    const direct = decodeTextContent(bytes);
    expect(await readTextContent(file)).toEqual(direct);
    expect(readTextContentSync(file)).toEqual(direct);
  });
});

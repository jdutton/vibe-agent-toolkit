/**
 * Unit tests for the content key.
 *
 * These carry the safety argument for a content-addressed parse cache. A
 * cold-vs-warm equivalence run over a frozen corpus cannot: three of the seven
 * known failure modes are structurally invisible to it (the enumerate→read
 * race, cross-worktree namespace collision, and concurrent/partial writes), and
 * the rest are caught only if someone independently anticipated the failure and
 * planted a fixture — at which point the fixture, not the equivalence run, is
 * doing the work. So the properties are asserted directly, over the key
 * function, here.
 */


import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  computeContentKey,
  type ContentKey,
  contentKeyParts,
  formatContentKey,
  isParsableContent,
  KEY_KINDS,
  type KeyedContent,
  type KeyKind,
  orderContentKeys,
  PARSER_KINDS,
  parseContentKey,
  type ParserKind,
  readContentWithKey,
} from '../src/content-key.js';
import { parserKindForPath } from '../src/projection/router.js';
import { testContentKey } from '../src/testing.js';

describe('parserKindForPath', () => {
  it.each([
    // Extension → MIME → parser.
    ['/a/b/doc.md', 'markdown'],
    ['/a/b/doc.markdown', 'markdown'],
    ['/a/b/notes.txt', 'markdown'],
    ['/a/b/page.html', 'html'],
    ['/a/b/page.htm', 'html'],
    ['/a/b/page.HTML', 'html'],
    ['/a/b/page.HtM', 'html'],

    // Extensionless WELL-KNOWNS keep the answer the extension-only routing gave
    // them, by a different route: no extension → basename table → `text/plain` →
    // markdown. Verified, not assumed — this pin predates the MIME rung and the
    // fact that it survives it unchanged is the evidence that no repository lost
    // its README to the new routing.
    ['/a/b/README', 'markdown'],
    ['/a/b/readme', 'markdown'],
    ['/a/b/CHANGELOG', 'markdown'],

    // ...and nothing else extensionless does. Under the old rule this was
    // markdown because the else-branch caught everything.
    ['/a/b/NOTES', 'none'],
    ['/a/b/.gitignore', 'none'],

    // The reason the third kind exists. Each of these was fed to remark before:
    // 5,329 `.ts` and 713 `.json` files in one measured adopter tree, which is
    // where 64.7% of all reference rows and 100% of dangling-reference warnings
    // came from. A JSON-Schema `pattern` of `"^[a-z][a-z0-9-]*$"` is two
    // adjacent bracket groups, i.e. a CommonMark reference link.
    ['/a/b/module.ts', 'none'],
    ['/a/b/schema.json', 'none'],
    ['/a/b/script.py', 'none'],
    ['/a/b/style.css', 'none'],
    ['/a/b/bun.lock', 'none'],

    // No name for it is still not a parser. `none` says "no document parser
    // ran", never "we know this is prose".
    ['/a/b/mystery.fraud-ingest-job', 'none'],
  ] as const)('routes %s to %s', (path, expected) => {
    expect(parserKindForPath(path)).toBe(expected);
  });

  it('does not treat a directory named *.html as html by accident of a suffix elsewhere', () => {
    // Only the trailing extension decides. `x.html.md` is markdown.
    expect(parserKindForPath('/a/x.html.md')).toBe('markdown');
  });

  it('never answers null — every path gets a kind, because every blob gets a row', () => {
    // The routing function stays NON-NULLABLE on purpose. A file nothing parses
    // still earns a `blobs` row (without one there is no `tokenEstimate`,
    // `whatLoadsAt` reports `tokens: null`, and the context-accounting lane
    // reports 'unknown-size'), a row needs a content key, and a key needs a
    // parser-kind prefix. So the absence of a parser has to be a VALUE.
    for (const path of ['/a/b/x.ts', '/a/b/x.md', '/a/b/x.html', '/a/b/x', '/a/b/.env']) {
      expect(parserKindForPath(path)).not.toBeNull();
    }
  });
});

describe('isParsableContent', () => {
  const keyedOf = (parserKind: ParserKind): KeyedContent => ({
    content: '',
    decoding: { encoding: 'utf-8', encodingSource: 'assumed', replacementCharacters: 0 },
    key: computeContentKey(new Uint8Array(), parserKind),
    parserKind,
    byteLength: 0,
  });

  it.each([
    ['markdown', true],
    ['html', true],
    ['none', false],
  ] as const)('reports %s as parsable=%s', (kind, expected) => {
    expect(isParsableContent(keyedOf(kind))).toBe(expected);
  });
});

/**
 * Encode a source string to the bytes `computeContentKey` takes.
 *
 * ⚠️ Every call below goes through this rather than passing a string directly.
 * That is not style: `createHash().update()` accepts a string happily, and NO
 * test file in this repository is typechecked — so a call site left passing a
 * string would compile, run, and pass while exercising a code path that no
 * longer exists in production.
 */
const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf-8');

describe('computeContentKey', () => {
  it('is stable for identical input', () => {
    expect(computeContentKey(bytes('# hi\n'), 'markdown')).toBe(computeContentKey(bytes('# hi\n'), 'markdown'));
  });

  it('is path-independent — the same bytes anywhere share a key', () => {
    // No path is an input at all; this test exists to pin that the signature
    // never grows one, because a path-derived key makes history replay and
    // cross-lane sharing impossible.
    const a = computeContentKey(bytes('same'), 'markdown');
    const b = computeContentKey(bytes('same'), 'markdown');
    expect(a).toBe(b);
  });

  it('separates ALL THREE kinds ON THE EMPTY FILE', () => {
    // This is the realizable case: git keys an empty file as e69de29… whatever
    // its extension, so a bytes-only key serves an HTML parse for a markdown
    // document and vice versa.
    const keys = (['markdown', 'html', 'none'] as const).map((kind) => computeContentKey(bytes(''), kind));
    expect(new Set(keys).size).toBe(3);
  });

  it('keeps the parser kind out of the digest: one hex under every kind, three keys', () => {
    // The kind is an unhashed qualifier, so a `sha256` hex can be compared with a digest computed
    // elsewhere over the same bytes (a Git LFS pointer's oid); the key text still separates them.
    const keys = (['markdown', 'html', 'none'] as const).map((kind) => computeContentKey(bytes('<p>x</p>'), kind));
    expect(new Set(keys.map((key) => contentKeyParts(key).hex)).size).toBe(1);
    expect(new Set(keys).size).toBe(3);
  });

  it('⭐ re-keys a file whose ROUTING changed, with no version constant to bump', () => {
    // The reason `none` is part of the key rather than being a bare
    // "skip" flag downstream. A `.ts` file used to route to markdown and now
    // routes to `none`; its bytes did not change, so a key over bytes alone would
    // serve the stale remark facts — 64.7% of the reference rows this change
    // exists to delete — out of a cache that looks perfectly healthy. Because
    // the kind is IN the key text, every such entry is unreachable the moment the
    // routing moves, and no hand-maintained schema/cache version decides it.
    // (Hand-maintained version constants are prohibited in this project; this is
    // what replaces one.)
    const source = bytes('const pattern = "^[a-z][a-z0-9-]*$";\n');
    expect(computeContentKey(source, 'none')).not.toBe(computeContentKey(source, 'markdown'));
  });

  it('distinguishes line endings', () => {
    // CRLF vs LF changes what remark sees; a Windows checkout must not collide
    // with a Unix one.
    expect(computeContentKey(bytes('a\nb\n'), 'markdown')).not.toBe(
      computeContentKey(bytes('a\r\nb\r\n'), 'markdown'),
    );
  });

  it('distinguishes trailing whitespace and BOM', () => {
    expect(computeContentKey(bytes('x'), 'markdown')).not.toBe(computeContentKey(bytes('x '), 'markdown'));
    expect(computeContentKey(bytes('x'), 'markdown')).not.toBe(computeContentKey(bytes('﻿x'), 'markdown'));
  });

  it('⭐ distinguishes byte sequences that DECODE IDENTICALLY', () => {
    // The reason the preimage is bytes and not the decoded string. UTF-8
    // decoding is many-to-one on invalid input — every malformed sequence
    // becomes U+FFFD — while `ParseResult.sizeBytes` is stat().size, a RAW byte
    // count that reaches rule variables and rewriting templates. Keyed on the
    // decoded string, these three files shared one key and had sizes 1, 2 and 1,
    // so a cache would serve a well-formed entry with the wrong contents.
    const invalid = [
      Uint8Array.from([0xc2]),
      Uint8Array.from([0xe2, 0x82]),
      Uint8Array.from([0xff]),
    ];
    const decoded = invalid.map((b) => Buffer.from(b).toString('utf-8'));
    // Precondition: they really are indistinguishable after decoding.
    expect(new Set(decoded).size).toBe(1);

    const keys = invalid.map((b) => computeContentKey(b, 'markdown'));
    expect(new Set(keys).size).toBe(3);

    // And mixing in the byte LENGTH would not have been enough: two of them
    // are the same length.
    expect(invalid[0]?.byteLength).toBe(invalid[2]?.byteLength);
  });

  it('cannot be impersonated by content that spells another kind', () => {
    // The kind is a field of the key text, not a prefix of the hashed bytes, so no content string
    // can shift a field boundary and pass for another (kind, content) pair.
    expect(computeContentKey(bytes('markdown x'), 'html')).not.toBe(computeContentKey(bytes('x'), 'markdown'));
  });

  it('carries no schema version — invalidation is the cache namespace\'s job', () => {
    // No schema version in the key: invalidation is the cache NAMESPACE's job
    // (one directory per build of VAT), so keys stay stable across releases and
    // a version bump no longer churns every recorded key.
    expect(computeContentKey(bytes('x'), 'markdown').startsWith('markdown.sha256.')).toBe(true);
  });

  it('names its key kind, so it can never be read as a git object ID', () => {
    const key = computeContentKey(bytes('x'), 'markdown');
    // Hand-written on purpose, and deliberately NOT `CONTENT_KEY_PATTERN`: this
    // assertion is the independent second opinion the exported pattern is
    // checked against, and reusing it would make the check circular.
    expect(key).toMatch(/^(markdown|html|none)\.sha256\.[0-9a-f]{64}$/);
    // Never bare hex, and a git object ID of the same bytes is a different key kind, so a different key.
    expect(key).not.toMatch(/^[0-9a-f]+$/);
    const gitKey = formatContentKey({ ...contentKeyParts(key), keyKind: 'git-sha256' });
    expect(gitKey).not.toBe(key);
  });
});

describe('readContentWithKey', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-content-key-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keys the bytes it returns', async () => {
    const file = safePath.join(dir, 'doc.md');
    writeFileSync(file, '# heading\n', 'utf-8');
    const keyed = await readContentWithKey(file, parserKindForPath(file), null);
    expect(keyed.content).toBe('# heading\n');
    expect(keyed.parserKind).toBe('markdown');
    expect(keyed.key).toBe(computeContentKey(bytes('# heading\n'), 'markdown'));
    expect(keyed.byteLength).toBe(10);
  });

  it('reads and keys a file NO parser will run over', async () => {
    // `none` is not a refusal to read — it is a refusal to PARSE. The bytes are
    // still read, still decoded and still keyed, because the blob row and its
    // `tokenEstimate` depend on them; only the document parser is skipped.
    const file = safePath.join(dir, 'module.ts');
    writeFileSync(file, 'export const x = 1;\n', 'utf-8');
    const keyed = await readContentWithKey(file, parserKindForPath(file), null);
    expect(keyed.parserKind).toBe('none');
    expect(keyed.key.startsWith('none.')).toBe(true);
    expect(keyed.content).toBe('export const x = 1;\n');
    expect(keyed.byteLength).toBe(20);
    expect(isParsableContent(keyed)).toBe(false);
  });

  it('reports a byteLength that the decoded content cannot reproduce', async () => {
    // The whole reason `byteLength` is carried rather than recomputed. These
    // bytes are not valid UTF-8, so the decode is lossy and
    // Buffer.byteLength(content) does not recover what was on disk —
    // `ParseResult.sizeBytes` is this number, and a cache must store it.
    const file = safePath.join(dir, 'malformed.md');
    writeFileSync(file, Uint8Array.from([0xe2, 0x82]));
    const keyed = await readContentWithKey(file, parserKindForPath(file), null);
    expect(keyed.byteLength).toBe(2);
    expect(Buffer.byteLength(keyed.content, 'utf-8')).not.toBe(keyed.byteLength);
  });

  it('gives two files that decode identically two different keys', async () => {
    const a = safePath.join(dir, 'invalid-a.md');
    const b = safePath.join(dir, 'invalid-b.md');
    writeFileSync(a, Uint8Array.from([0xc2]));
    writeFileSync(b, Uint8Array.from([0xff]));
    const [keyedA, keyedB] = await Promise.all([
      readContentWithKey(a, parserKindForPath(a), null),
      readContentWithKey(b, parserKindForPath(b), null),
    ]);
    expect(keyedA.content).toBe(keyedB.content);
    expect(keyedA.key).not.toBe(keyedB.key);
  });

  it('re-keys after the file changes — no enumerate→read window', async () => {
    const file = safePath.join(dir, 'mutating.md');
    writeFileSync(file, 'before\n', 'utf-8');
    const first = await readContentWithKey(file, parserKindForPath(file), null);
    writeFileSync(file, 'after\n', 'utf-8');
    const second = await readContentWithKey(file, parserKindForPath(file), null);
    expect(second.key).not.toBe(first.key);
    expect(second.content).toBe('after\n');
  });

  it('routes the same bytes at two extensions to two keys', async () => {
    const md = safePath.join(dir, 'twin.md');
    const html = safePath.join(dir, 'twin.html');
    writeFileSync(md, '', 'utf-8');
    writeFileSync(html, '', 'utf-8');
    const [a, b] = await Promise.all([
      readContentWithKey(md, parserKindForPath(md), null),
      readContentWithKey(html, parserKindForPath(html), null),
    ]);
    expect(a.key).not.toBe(b.key);
  });

  it('keys by the parser it is TOLD to use, not by the extension', async () => {
    // The reason `parserKind` is a required argument. `lancedb-rag-provider`
    // hands every resource — including the `.html` ones the registry crawls —
    // to the markdown parser. If this function derived the kind from the
    // extension, that lane's markdown facts would be filed under the same key
    // the registry's genuine HTML parse uses, and one would be served the
    // other's facts: a well-formed entry with the wrong contents.
    const page = safePath.join(dir, 'page.html');
    writeFileSync(page, '<p>hi</p>\n', 'utf-8');

    const [asMarkdown, asHtml] = await Promise.all([
      readContentWithKey(page, 'markdown', null),
      readContentWithKey(page, 'html', null),
    ]);

    expect(asMarkdown.content).toBe(asHtml.content);
    expect(asMarkdown.key).not.toBe(asHtml.key);
    expect(asMarkdown.parserKind).toBe('markdown');
    // And the extension-derived answer is genuinely the OTHER one, so this test
    // could not pass under a defaulted implementation.
    expect(parserKindForPath(page)).toBe('html');
  });

  it('keys a symlink by what it RESOLVES TO, not by its target string', async () => {
    // Git stores a symlink as a blob containing the link target string (mode
    // 120000), so two symlinks with the same relative target that resolve to
    // different files share a blob SHA — measured. VAT's crawler follows
    // symlinks and the parser reads through, so a blob-keyed cache would serve
    // one document's parse for another. Hashing on read makes the collision
    // unreachable: the key is over the bytes that came back.
    const subA = safePath.join(dir, 'sub-a');
    const subB = safePath.join(dir, 'sub-b');
    mkdirSyncReal(subA, { recursive: true });
    mkdirSyncReal(subB, { recursive: true });
    writeFileSync(safePath.join(subA, 'target.md'), 'AAA\n', 'utf-8');
    writeFileSync(safePath.join(subB, 'target.md'), 'BBB\n', 'utf-8');

    const cap = symlinkCapability();
    if (!cap) {
      // Windows without Developer Mode or SeCreateSymbolicLinkPrivilege. Say so
      // rather than passing silently — a green that never ran is the failure
      // mode this whole suite exists to avoid.
      console.warn('content-key: symlink creation unavailable on this host; blob-collision case not exercised');
      return;
    }

    // Identical target STRING in both directories, different resolved bytes.
    createSymlink(cap, 'target.md', safePath.join(subA, 'link.md'));
    createSymlink(cap, 'target.md', safePath.join(subB, 'link.md'));

    const [a, b] = await Promise.all([
      readContentWithKey(safePath.join(subA, 'link.md'), 'markdown', null),
      readContentWithKey(safePath.join(subB, 'link.md'), 'markdown', null),
    ]);
    expect(a.content).toBe('AAA\n');
    expect(b.content).toBe('BBB\n');
    expect(a.key).not.toBe(b.key);
  });
});

describe('computeContentKey: the sha256 key text', () => {
  const sha256Hex = (input: Uint8Array): string => createHash('sha256').update(input).digest('hex');

  it('formats <parserKind>.sha256.<plain SHA-256 of the raw bytes>, no domain separator', () => {
    const input = bytes('# hi\n');
    expect(computeContentKey(input, 'markdown')).toBe(`markdown.sha256.${sha256Hex(input)}`);
  });

  it('gives identical bytes at two paths under one kind one key whose hex is their SHA-256', () => {
    // The sha256 duplicate bound: the key is a function of (kind, bytes) only and its hex is
    // exactly the bytes' SHA-256, so two copies are never keyed apart nor two contents together.
    const first = bytes('shared body\n');
    const second = Buffer.from('shared body\n', 'utf-8');
    const a = computeContentKey(first, 'markdown');
    const b = computeContentKey(second, 'markdown');
    expect(a).toBe(b);
    expect(a.slice(a.lastIndexOf('.') + 1)).toBe(sha256Hex(first));
  });
});

/** A hex string of `length` characters, all `digit`. */
const hexOf = (digit: string, length: number): string => digit.repeat(length);

/** The hex length each key kind carries, written out independently of the module. */
const HEX_LENGTH: Readonly<Record<KeyKind, number>> = { sha256: 64, 'git-sha1': 40, 'git-sha256': 64 };

/** One key per (parser kind, key kind, hex digit): the sample every property below ranges over. */
const SAMPLE: readonly ContentKey[] = PARSER_KINDS.flatMap((parserKind) =>
  KEY_KINDS.flatMap((keyKind) =>
    ['0', '7', 'f'].map((digit) => formatContentKey({ parserKind, keyKind, hex: hexOf(digit, HEX_LENGTH[keyKind]) })),
  ),
);

describe('parseContentKey and formatContentKey', () => {
  it('round-trips every parser kind and key kind: parse(format(k)) == k', () => {
    for (const parserKind of PARSER_KINDS) {
      for (const keyKind of KEY_KINDS) {
        const parts = { parserKind, keyKind, hex: hexOf('a', HEX_LENGTH[keyKind]) };
        const key = formatContentKey(parts);
        expect(key).toBe(`${parserKind}.${keyKind}.${parts.hex}`);
        expect(parseContentKey(key)).toBe(key);
        expect(contentKeyParts(key)).toEqual(parts);
      }
    }
  });

  it.each([
    ['a 40-hex sha256', `markdown.sha256.${hexOf('a', 40)}`],
    ['a 64-hex git-sha1', `markdown.git-sha1.${hexOf('a', 64)}`],
    ['a 40-hex git-sha256', `markdown.git-sha256.${hexOf('a', 40)}`],
    ['a 63-hex sha256', `markdown.sha256.${hexOf('a', 63)}`],
    ['an unknown parser kind', `pdf.sha256.${hexOf('a', 64)}`],
    ['an unknown key kind', `markdown.md5.${hexOf('a', 64)}`],
    ['uppercase hex', `markdown.sha256.${hexOf('A', 64)}`],
    ['a missing key kind (the old format)', `markdown.${hexOf('a', 64)}`],
    ['a path traversal', `markdown.sha256..${hexOf('a', 63)}`],
    ['a bare dot-dot', '..'],
    ['the empty string', ''],
  ])('refuses %s', (_label, text) => {
    expect(parseContentKey(text)).toBeUndefined();
  });

  it('accepts exactly the right hex length per key kind', () => {
    for (const keyKind of KEY_KINDS) {
      expect(parseContentKey(`html.${keyKind}.${hexOf('0', HEX_LENGTH[keyKind])}`)).toBeDefined();
    }
  });

  it('throws when formatting a malformed part', () => {
    expect(() => formatContentKey({ parserKind: 'markdown', keyKind: 'sha256', hex: hexOf('a', 40) })).toThrow();
  });
});

describe('orderContentKeys', () => {
  const sign = (n: number): number => Math.sign(n);
  const textOrder = (a: string, b: string): number => {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  };

  it('equals code-unit text order over a sample spanning every parser kind and key kind', () => {
    for (const a of SAMPLE) {
      for (const b of SAMPLE) {
        expect(sign(orderContentKeys(a, b)), `${a} vs ${b}`).toBe(textOrder(a, b));
      }
    }
  });

  it('is total: antisymmetric, transitive and consistent with equals', () => {
    for (const x of SAMPLE) {
      for (const y of SAMPLE) {
        expect(sign(orderContentKeys(x, y)) + sign(orderContentKeys(y, x)), `${x} vs ${y}`).toBe(0);
        expect(orderContentKeys(x, y) === 0).toBe(x === y);
        for (const z of SAMPLE) {
          if (orderContentKeys(x, y) < 0 && orderContentKeys(y, z) < 0) expect(orderContentKeys(x, z)).toBeLessThan(0);
        }
      }
    }
  });

  it('agrees with the tuple order (parserKind, keyKind, hex)', () => {
    const tupleOrder = (a: ContentKey, b: ContentKey): number => {
      const [pa, pb] = [contentKeyParts(a), contentKeyParts(b)];
      return textOrder(pa.parserKind, pb.parserKind) || textOrder(pa.keyKind, pb.keyKind) || textOrder(pa.hex, pb.hex);
    };
    for (const a of SAMPLE) {
      for (const b of SAMPLE) expect(sign(orderContentKeys(a, b)), `${a} vs ${b}`).toBe(tupleOrder(a, b));
    }
  });

  it('no kind word is a proper prefix of another at the "." boundary, so text order is tuple order', () => {
    for (const words of [PARSER_KINDS, KEY_KINDS] as const) {
      for (const a of words) {
        for (const b of words) {
          if (a !== b) expect(`${b}.`.startsWith(`${a}.`) || b.startsWith(a), `${a} prefixes ${b}`).toBe(false);
        }
      }
    }
  });
});

describe('testContentKey', () => {
  it('mints a well-formed sha256 key of the kind asked for, one per seed', () => {
    const key = testContentKey('html', 'a');
    expect(parseContentKey(key)).toBe(key);
    expect(contentKeyParts(key)).toMatchObject({ parserKind: 'html', keyKind: 'sha256' });
    expect(testContentKey('html', 'a')).toBe(key);
    expect(testContentKey('html', 'b')).not.toBe(key);
  });
});

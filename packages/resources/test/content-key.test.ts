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

/* eslint-disable security/detect-non-literal-fs-filename -- every path derives from a mkdtemp root created here. */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import { canCreateSymlinks, mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  computeContentKey,
  parserKindForPath,
  readContentWithKey,
} from '../src/content-key.js';

describe('parserKindForPath', () => {
  it.each([
    ['/a/b/doc.md', 'markdown'],
    ['/a/b/doc.markdown', 'markdown'],
    ['/a/b/README', 'markdown'],
    ['/a/b/page.html', 'html'],
    ['/a/b/page.htm', 'html'],
    ['/a/b/page.HTML', 'html'],
    ['/a/b/page.HtM', 'html'],
  ] as const)('routes %s to %s', (path, expected) => {
    expect(parserKindForPath(path)).toBe(expected);
  });

  it('does not treat a directory named *.html as html by accident of a suffix elsewhere', () => {
    // Only the trailing extension decides. `x.html.md` is markdown.
    expect(parserKindForPath('/a/x.html.md')).toBe('markdown');
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

  it('separates the two parsers ON THE EMPTY FILE', () => {
    // This is the realizable case: git keys an empty file as e69de29… whatever
    // its extension, so a bytes-only key serves an HTML parse for a markdown
    // document and vice versa.
    expect(computeContentKey(bytes(''), 'markdown')).not.toBe(computeContentKey(bytes(''), 'html'));
  });

  it('separates the two parsers in the DIGEST, not merely in the prefix', () => {
    const md = computeContentKey(bytes('<p>x</p>'), 'markdown');
    const html = computeContentKey(bytes('<p>x</p>'), 'html');
    const digestOf = (key: string): string => key.slice(key.lastIndexOf('.') + 1);
    expect(digestOf(md)).not.toBe(digestOf(html));
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

  it('is not length-extendable across the domain separator', () => {
    // The preimage is `<domain>\0<version>\0<kind>\0` + content. NUL is used
    // because it cannot occur in any of the three prefix fields, so no content
    // string can shift a field boundary and impersonate another (kind, content)
    // pair. (The separator is written as the ESCAPE `\0`, never as a raw byte:
    // a source file containing a literal NUL is treated as binary by git and
    // ripgrep and vanishes from every grep-based sweep.)
    expect(computeContentKey(bytes('markdown x'), 'html')).not.toBe(computeContentKey(bytes('x'), 'markdown'));
  });

  it('carries no schema version — invalidation is the cache namespace\'s job', () => {
    // No schema version in the key: invalidation is the cache NAMESPACE's job
    // (one directory per build of VAT), so keys stay stable across releases and
    // a version bump no longer churns every recorded key.
    expect(computeContentKey(bytes('x'), 'markdown').startsWith('markdown.')).toBe(true);
  });

  it('is domain-tagged so it can never be read as a git SHA-1', () => {
    const key = computeContentKey(bytes('x'), 'markdown');
    expect(key).toMatch(/^(markdown|html)\.[0-9a-f]{64}$/);
    // 64 hex chars, and never bare hex — a git blob SHA-1 is 40 bare hex chars,
    // so the two keyspaces cannot be mixed by accidental hex length.
    expect(key).not.toMatch(/^[0-9a-f]+$/);
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
    const keyed = await readContentWithKey(file, parserKindForPath(file));
    expect(keyed.content).toBe('# heading\n');
    expect(keyed.parserKind).toBe('markdown');
    expect(keyed.key).toBe(computeContentKey(bytes('# heading\n'), 'markdown'));
    expect(keyed.byteLength).toBe(10);
  });

  it('reports a byteLength that the decoded content cannot reproduce', async () => {
    // The whole reason `byteLength` is carried rather than recomputed. These
    // bytes are not valid UTF-8, so the decode is lossy and
    // Buffer.byteLength(content) does not recover what was on disk —
    // `ParseResult.sizeBytes` is this number, and a cache must store it.
    const file = safePath.join(dir, 'malformed.md');
    writeFileSync(file, Uint8Array.from([0xe2, 0x82]));
    const keyed = await readContentWithKey(file, parserKindForPath(file));
    expect(keyed.byteLength).toBe(2);
    expect(Buffer.byteLength(keyed.content, 'utf-8')).not.toBe(keyed.byteLength);
  });

  it('gives two files that decode identically two different keys', async () => {
    const a = safePath.join(dir, 'invalid-a.md');
    const b = safePath.join(dir, 'invalid-b.md');
    writeFileSync(a, Uint8Array.from([0xc2]));
    writeFileSync(b, Uint8Array.from([0xff]));
    const [keyedA, keyedB] = await Promise.all([
      readContentWithKey(a, parserKindForPath(a)),
      readContentWithKey(b, parserKindForPath(b)),
    ]);
    expect(keyedA.content).toBe(keyedB.content);
    expect(keyedA.key).not.toBe(keyedB.key);
  });

  it('re-keys after the file changes — no enumerate→read window', async () => {
    const file = safePath.join(dir, 'mutating.md');
    writeFileSync(file, 'before\n', 'utf-8');
    const first = await readContentWithKey(file, parserKindForPath(file));
    writeFileSync(file, 'after\n', 'utf-8');
    const second = await readContentWithKey(file, parserKindForPath(file));
    expect(second.key).not.toBe(first.key);
    expect(second.content).toBe('after\n');
  });

  it('routes the same bytes at two extensions to two keys', async () => {
    const md = safePath.join(dir, 'twin.md');
    const html = safePath.join(dir, 'twin.html');
    writeFileSync(md, '', 'utf-8');
    writeFileSync(html, '', 'utf-8');
    const [a, b] = await Promise.all([
      readContentWithKey(md, parserKindForPath(md)),
      readContentWithKey(html, parserKindForPath(html)),
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
      readContentWithKey(page, 'markdown'),
      readContentWithKey(page, 'html'),
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

    if (!canCreateSymlinks(dir)) {
      // Windows without Developer Mode or SeCreateSymbolicLinkPrivilege. Say so
      // rather than passing silently — a green that never ran is the failure
      // mode this whole suite exists to avoid.
      console.warn('content-key: symlink creation unavailable on this host; blob-collision case not exercised');
      return;
    }

    // Identical target STRING in both directories, different resolved bytes.
    symlinkSync('target.md', safePath.join(subA, 'link.md'));
    symlinkSync('target.md', safePath.join(subB, 'link.md'));

    const [a, b] = await Promise.all([
      readContentWithKey(safePath.join(subA, 'link.md'), 'markdown'),
      readContentWithKey(safePath.join(subB, 'link.md'), 'markdown'),
    ]);
    expect(a.content).toBe('AAA\n');
    expect(b.content).toBe('BBB\n');
    expect(a.key).not.toBe(b.key);
  });
});

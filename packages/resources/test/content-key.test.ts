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
  CONTENT_KEY_SCHEMA_VERSION,
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

describe('computeContentKey', () => {
  it('is stable for identical input', () => {
    expect(computeContentKey('# hi\n', 'markdown')).toBe(computeContentKey('# hi\n', 'markdown'));
  });

  it('is path-independent — the same bytes anywhere share a key', () => {
    // No path is an input at all; this test exists to pin that the signature
    // never grows one, because a path-derived key makes history replay and
    // cross-lane sharing impossible.
    const a = computeContentKey('same', 'markdown');
    const b = computeContentKey('same', 'markdown');
    expect(a).toBe(b);
  });

  it('separates the two parsers ON THE EMPTY FILE', () => {
    // This is the realizable case: git keys an empty file as e69de29… whatever
    // its extension, so a bytes-only key serves an HTML parse for a markdown
    // document and vice versa.
    expect(computeContentKey('', 'markdown')).not.toBe(computeContentKey('', 'html'));
  });

  it('separates the two parsers in the DIGEST, not merely in the prefix', () => {
    const md = computeContentKey('<p>x</p>', 'markdown');
    const html = computeContentKey('<p>x</p>', 'html');
    const digestOf = (key: string): string => key.slice(key.lastIndexOf('.') + 1);
    expect(digestOf(md)).not.toBe(digestOf(html));
  });

  it('distinguishes line endings', () => {
    // CRLF vs LF changes what remark sees; a Windows checkout must not collide
    // with a Unix one.
    expect(computeContentKey('a\nb\n', 'markdown')).not.toBe(computeContentKey('a\r\nb\r\n', 'markdown'));
  });

  it('distinguishes trailing whitespace and BOM', () => {
    expect(computeContentKey('x', 'markdown')).not.toBe(computeContentKey('x ', 'markdown'));
    expect(computeContentKey('x', 'markdown')).not.toBe(computeContentKey('﻿x', 'markdown'));
  });

  it('is not length-extendable across the domain separator', () => {
    // The preimage is `<domain>\0<version>\0<kind>\0` + content. NUL is used
    // because it cannot occur in any of the three prefix fields, so no content
    // string can shift a field boundary and impersonate another (kind, content)
    // pair. (The separator is written as the ESCAPE `\0`, never as a raw byte:
    // a source file containing a literal NUL is treated as binary by git and
    // ripgrep and vanishes from every grep-based sweep.)
    expect(computeContentKey('markdown x', 'html')).not.toBe(computeContentKey('x', 'markdown'));
  });

  it('carries the schema version, so a parser change has an invalidation lever', () => {
    expect(computeContentKey('x', 'markdown')).toContain(`k${String(CONTENT_KEY_SCHEMA_VERSION)}.`);
  });

  it('is domain-tagged so it can never be read as a git SHA-1', () => {
    const key = computeContentKey('x', 'markdown');
    expect(key).toMatch(/^k\d+\.(markdown|html)\.[0-9a-f]{64}$/);
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
    const keyed = await readContentWithKey(file);
    expect(keyed.content).toBe('# heading\n');
    expect(keyed.parserKind).toBe('markdown');
    expect(keyed.key).toBe(computeContentKey('# heading\n', 'markdown'));
  });

  it('re-keys after the file changes — no enumerate→read window', async () => {
    const file = safePath.join(dir, 'mutating.md');
    writeFileSync(file, 'before\n', 'utf-8');
    const first = await readContentWithKey(file);
    writeFileSync(file, 'after\n', 'utf-8');
    const second = await readContentWithKey(file);
    expect(second.key).not.toBe(first.key);
    expect(second.content).toBe('after\n');
  });

  it('routes the same bytes at two extensions to two keys', async () => {
    const md = safePath.join(dir, 'twin.md');
    const html = safePath.join(dir, 'twin.html');
    writeFileSync(md, '', 'utf-8');
    writeFileSync(html, '', 'utf-8');
    const [a, b] = await Promise.all([readContentWithKey(md), readContentWithKey(html)]);
    expect(a.key).not.toBe(b.key);
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
      readContentWithKey(safePath.join(subA, 'link.md')),
      readContentWithKey(safePath.join(subB, 'link.md')),
    ]);
    expect(a.content).toBe('AAA\n');
    expect(b.content).toBe('BBB\n');
    expect(a.key).not.toBe(b.key);
  });
});

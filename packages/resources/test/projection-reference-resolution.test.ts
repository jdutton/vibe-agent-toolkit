/**
 * `reference-resolution.ts` — the half of resolution that does not depend on
 * who is asking, and the ONE answer to "is this token a path into the corpus".
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { describe, expect, it } from 'vitest';

import { isNonLocalRef, resolveReferencePath } from '../src/projection/reference-resolution.js';

const ROOT = safePath.join(normalizedTmpdir(), 'reference-resolution-corpus');
const FROM = 'docs/guide.md';

describe('isNonLocalRef — one predicate, imported by every consumer', () => {
  it.each([
    ['a scheme-qualified URL', 'https://example.com/x'],
    // The case a `://` test misses: no slashes at all.
    ['a mailto: reference', 'mailto:someone@example.com'],
    ['a tel: reference', 'tel:+15555550100'],
    // 🚨 The case a colon-before-slash test misses: no colon at all. Discovery
    // used its own `hasUriScheme`, which answered FALSE here and handed the
    // token to the path resolver, which resolved `//cdn.example/lib.js` to the
    // plausible relative filename `cdn.example/lib.js` — reported as an
    // unrealized document that nobody wrote.
    ['a protocol-relative reference', '//cdn.example/lib.js'],
    // An absolute drive path is not a corpus-relative reference either.
    ['a Windows drive path', String.raw`C:\docs\x.md`],
  ])('is true for %s', (_name, rawRef) => {
    expect(isNonLocalRef(rawRef)).toBe(true);
  });

  it.each([
    ['a relative path', './guide.md'],
    ['a bare filename', 'guide.md'],
    ['a root-absolute path', '/docs/guide.md'],
    ['an anchor', '#section'],
    // RFC 3986 §3.1: a scheme starts with a LETTER, so this is a relative
    // path with a colon in it — which a colon-before-slash test got wrong.
    ['a path whose first segment starts with a digit and carries a colon', '1:notes.md'],
    ['a path with a colon after a slash', 'docs/a:b.md'],
  ])('is false for %s', (_name, rawRef) => {
    expect(isNonLocalRef(rawRef)).toBe(false);
  });
});

describe('resolveReferencePath — three outcomes, kept apart', () => {
  it('reports a relative reference inside the root as inside-root', () => {
    expect(resolveReferencePath('href', './intro.md', FROM, ROOT))
      .toEqual({ kind: 'inside-root', path: 'docs/intro.md' });
  });

  it('reports a relative reference that climbs out as outside-root, with the path', () => {
    expect(resolveReferencePath('href', '../../shared/doc.md', FROM, ROOT))
      .toEqual({ kind: 'outside-root', path: '../shared/doc.md' });
  });

  it('reports a ROOT-ABSOLUTE reference that escapes the root as outside-root, not unresolvable', () => {
    // 🚨 `resolveLocalHref`'s `absolute_escapes_root` verdict was folded into
    // `unresolvable` ("the token named no file") — but `/../../shared/doc.md`
    // names a real destination this corpus simply stops short of, which is
    // exactly the distinction the union's own docstring says must not be
    // collapsed, because collapsing it makes a dangling-link count a fiction.
    // The path is carried the way `relativize` spells it, from the resolved
    // candidate the resolver already computed — no second resolution here.
    expect(resolveReferencePath('href', '/../../shared/doc.md', FROM, ROOT))
      .toEqual({ kind: 'outside-root', path: '../../shared/doc.md' });
  });

  it('reports an anchor-only reference as unresolvable — it names no file', () => {
    expect(resolveReferencePath('href', '#section', FROM, ROOT)).toEqual({ kind: 'unresolvable' });
  });
});

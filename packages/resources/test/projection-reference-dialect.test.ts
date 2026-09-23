import { homedir } from 'node:os';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { resolveDialectRef } from '../src/projection/contributors/reference-dialect.js';

/**
 * A root that is never touched on disk.
 *
 * Deliberately not under `/tmp` (`sonarjs/publicly-writable-directories`), and
 * deliberately never created: this resolution is lexical, so a fixture needing
 * files on disk would be testing the wrong thing.
 *
 * 🪤 **Resolved rather than written as a literal, because a bare `/…` is not
 * absolute on Windows.** `safePath.resolve` qualifies it with the current drive
 * there (`D:/vat-corpus/…`) and returns it unchanged on POSIX — which is exactly
 * what the resolver under test does to it. Held as a literal, every
 * `` `${ROOT}/…` `` expectation below is missing the drive letter the production
 * code correctly adds, and four tests fail on Windows for a defect that is
 * entirely in the fixture. The `@/abs/notes.md` case further down already used
 * `safePath.resolve` for this reason; the root did not, and that inconsistency
 * is the whole bug.
 */
const ROOT = safePath.resolve('/vat-corpus/dialect-fixture');

/** The file the references are authored in. */
const SOURCE = `${ROOT}/docs/CLAUDE.md`;

/** The dialect under test, named once so the suite reads as one subject. */
const CLAUDE_IMPORT = 'claude-import' as const;

/** The `resolvedPath` of a resolution, or undefined when it did not resolve. */
function resolvedPathOf(result: ReturnType<typeof resolveDialectRef>): string | undefined {
  return result.kind === 'resolved' ? result.resolvedPath : undefined;
}

describe('resolveDialectRef — href dialect', () => {
  it('is resolveLocalHref verbatim, so it has no @ branch', () => {
    // The whole defect, stated as the behaviour it actually is: under RFC 3986
    // an `@` is an ordinary filename character, so `@b.md` names a file called
    // `@b.md`. That is correct for a markdown href and wrong for an import.
    expect(resolveDialectRef('href', '@b.md', SOURCE, ROOT)).toEqual({
      kind: 'resolved',
      resolvedPath: `${ROOT}/docs/@b.md`,
      anchor: undefined,
    });
  });

  it('reads a leading slash as ROOT-relative, per RFC 3986 §4.2', () => {
    expect(resolvedPathOf(resolveDialectRef('href', '/docs/b.md', SOURCE, ROOT)))
      .toBe(safePath.resolve(ROOT, 'docs/b.md'));
  });
});

describe('resolveDialectRef — claude-import dialect', () => {
  // The token is a `blob_claude_imports.target`: the harness's extractor has
  // already dropped the `@`, cut the fragment and unescaped `\ `. What is left
  // is the binary's `et`.

  it('resolves a relative target against the IMPORTING file, literally', () => {
    expect(resolveDialectRef(CLAUDE_IMPORT, 'b.md', SOURCE, ROOT)).toEqual({
      kind: 'resolved',
      resolvedPath: `${ROOT}/docs/b.md`,
      anchor: undefined,
    });
    // `et` percent-decodes nothing: `%20` is three characters of a file name.
    // The control is `href`, which decodes it.
    expect(resolvedPathOf(resolveDialectRef(CLAUDE_IMPORT, 'my%20file.md', SOURCE, ROOT)))
      .toBe(`${ROOT}/docs/my%20file.md`);
    expect(resolvedPathOf(resolveDialectRef('href', 'my%20file.md', SOURCE, ROOT)))
      .toBe(`${ROOT}/docs/my file.md`);
  });

  it('expands ~/ to the home directory, landing OUTSIDE the corpus', () => {
    // The vendor's own recommended cross-worktree spelling. Resolving it INSIDE
    // the root is what made the one import that is working correctly read as a
    // broken one — and any severity rule escalating a path-shaped unresolved ref
    // would then warn on exactly it.
    const result = resolveDialectRef(CLAUDE_IMPORT, '~/.claude/my-project-instructions.md', SOURCE, ROOT);

    expect(result).toEqual({
      kind: 'resolved',
      resolvedPath: safePath.join(homedir(), '.claude/my-project-instructions.md'),
      anchor: undefined,
    });
    // The consequence, asserted rather than assumed: the closure's containment
    // check must see this as an escape, so it reports OUTSIDE_ROOT (healthy,
    // never escalated) instead of UNRESOLVED (a broken link).
    expect(resolvedPathOf(result)?.startsWith(`${ROOT}/`)).toBe(false);
  });

  it('reads a bare ~ as the home directory itself', () => {
    expect(resolvedPathOf(resolveDialectRef(CLAUDE_IMPORT, '~', SOURCE, ROOT))).toBe(safePath.resolve(homedir()));
  });

  it('reads a leading slash as FILESYSTEM-absolute, not root-relative', () => {
    // The vendor's meaning, and the opposite of `resolveLocalHref`'s. The second
    // assertion is the control: the SAME token under `href` lands inside the
    // corpus, which is what makes this a real divergence rather than a
    // restatement.
    expect(resolvedPathOf(resolveDialectRef(CLAUDE_IMPORT, '/etc/shared/policy.md', SOURCE, ROOT)))
      .toBe(safePath.resolve('/etc/shared/policy.md'));
    expect(resolvedPathOf(resolveDialectRef('href', '/etc/shared/policy.md', SOURCE, ROOT)))
      .toBe(safePath.resolve(ROOT, 'etc/shared/policy.md'));
  });

  it('trims the target, as `et` does, and names no file when nothing is left', () => {
    // `@a.md\ ` extracts as `a.md ` — the escaped space survives the scanner
    // and `et` trims it. A target of only spaces would resolve to the importing
    // DIRECTORY; answering anchor-only keeps a directory out of the extent.
    expect(resolvedPathOf(resolveDialectRef(CLAUDE_IMPORT, 'a.md ', SOURCE, ROOT))).toBe(`${ROOT}/docs/a.md`);
    expect(resolveDialectRef(CLAUDE_IMPORT, '  ', SOURCE, ROOT)).toEqual({ kind: 'anchor_only' });
  });
});

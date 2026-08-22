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
 */
const ROOT = '/vat-corpus/dialect-fixture';

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
  it('strips one leading @ and resolves relative to the IMPORTING file', () => {
    expect(resolveDialectRef(CLAUDE_IMPORT, '@b.md', SOURCE, ROOT)).toEqual({
      kind: 'resolved',
      resolvedPath: `${ROOT}/docs/b.md`,
      anchor: undefined,
    });
  });

  it('resolves a token with no @ exactly as href would', () => {
    // The dialect strips an `@` when there is one; it does not require one. A
    // rules file whose import is authored bare must still resolve, and it must
    // resolve identically — the dialect changes three rules, not all of them.
    expect(resolveDialectRef(CLAUDE_IMPORT, './b.md', SOURCE, ROOT))
      .toEqual(resolveDialectRef('href', './b.md', SOURCE, ROOT));
  });

  it('expands @~/ to the home directory, landing OUTSIDE the corpus', () => {
    // The vendor's own recommended cross-worktree spelling. Resolving it INSIDE
    // the root is what made the one import that is working correctly read as a
    // broken one — and any severity rule escalating a path-shaped unresolved ref
    // would then warn on exactly it.
    const result = resolveDialectRef(
      CLAUDE_IMPORT,
      '@~/.claude/my-project-instructions.md',
      SOURCE,
      ROOT,
    );

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

  it('reads a leading slash as FILESYSTEM-absolute, not root-relative', () => {
    // The vendor's meaning, and the opposite of `resolveLocalHref`'s. The second
    // assertion is the control: the SAME token under `href` lands inside the
    // corpus, which is what makes this a real divergence rather than a
    // restatement.
    expect(resolvedPathOf(resolveDialectRef(CLAUDE_IMPORT, '@/etc/shared/policy.md', SOURCE, ROOT)))
      .toBe(safePath.resolve('/etc/shared/policy.md'));
    expect(resolvedPathOf(resolveDialectRef('href', '/etc/shared/policy.md', SOURCE, ROOT)))
      .toBe(safePath.resolve(ROOT, 'etc/shared/policy.md'));
  });

  it('treats a bare @ as anchor-only rather than resolving the source directory', () => {
    // Stripping the `@` leaves the empty string, and an empty href resolves to
    // the containing DIRECTORY. Admitting that would make a stray `@` in prose
    // pull a directory into the extent.
    expect(resolveDialectRef(CLAUDE_IMPORT, '@', SOURCE, ROOT)).toEqual({ kind: 'anchor_only' });
  });

  it('strips only ONE @, so @@b.md names a file that starts with @', () => {
    // A greedy strip would make a file genuinely named `@b.md` unreachable.
    expect(resolvedPathOf(resolveDialectRef(CLAUDE_IMPORT, '@@b.md', SOURCE, ROOT)))
      .toBe(`${ROOT}/docs/@b.md`);
  });

  it('carries an anchor through every branch', () => {
    // `splitHrefAnchor` runs on all three routes, not only the delegated one —
    // an anchor left glued to a `~/` or `/` path would make it name no file.
    expect(resolveDialectRef(CLAUDE_IMPORT, '@b.md#section', SOURCE, ROOT).kind)
      .toBe('resolved');
    expect(resolveDialectRef(CLAUDE_IMPORT, '@b.md#section', SOURCE, ROOT))
      .toEqual({ kind: 'resolved', resolvedPath: `${ROOT}/docs/b.md`, anchor: 'section' });
    expect(resolveDialectRef(CLAUDE_IMPORT, '@~/notes.md#top', SOURCE, ROOT))
      .toEqual({ kind: 'resolved', resolvedPath: safePath.join(homedir(), 'notes.md'), anchor: 'top' });
    expect(resolveDialectRef(CLAUDE_IMPORT, '@/abs/notes.md#top', SOURCE, ROOT))
      .toEqual({ kind: 'resolved', resolvedPath: safePath.resolve('/abs/notes.md'), anchor: 'top' });
  });
});

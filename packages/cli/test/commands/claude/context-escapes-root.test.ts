/**
 * The containment guard on the path arguments of `vat claude context` and its
 * sibling `vat claude budget` — one predicate, shared, in `utils/corpus-target`.
 *
 * ## Why the predicate is tested and not the function that calls it
 *
 * `targetPathWithin` derives its argument from `safePath.relative`, and on
 * POSIX `path.relative` between two absolute paths NEVER returns an absolute
 * string — it always finds a `../…` route. So the drive-letter case that
 * motivates the third clause is unreachable through that function on every
 * machine a developer or a Linux CI runner uses, and a test written against it
 * would pass identically with the clause deleted. Calling
 * {@link escapesCorpusRoot} directly with the string Windows really produces is
 * the only way this branch is exercised anywhere except a Windows runner, and
 * "only on the platform nobody watches" is how the clause came to be missing.
 *
 * The consequence it prevents is concrete: `vat claude context D:\elsewhere\doc.md`
 * from a `C:` repository would pass the guard, be handed to a projection that
 * never enumerated `D:`, and come back `kind: unknown` — indistinguishable from
 * a typo inside the tree, which is the exact outcome the guard's `@throws`
 * claims to rule out.
 */

import { describe, expect, it } from 'vitest';

import { escapesCorpusRoot } from '../../../src/utils/corpus-target.js';

describe('escapesCorpusRoot', () => {
  it('admits paths the corpus root really contains', () => {
    // The control. A guard asserted only from the refusing side is also
    // satisfied by one that refuses everything.
    expect(escapesCorpusRoot('')).toBe(false);
    expect(escapesCorpusRoot('packages/cli/src/index.ts')).toBe(false);
    expect(escapesCorpusRoot('docs')).toBe(false);
  });

  it('refuses the two relative spellings of "above the root"', () => {
    // `..` carries no trailing separator, so it needs its own test — the
    // `../` prefix check alone does not match it.
    expect(escapesCorpusRoot('..')).toBe(true);
    expect(escapesCorpusRoot('../elsewhere/doc.md')).toBe(true);
  });

  it('refuses a Windows drive-letter path, in both slash spellings', () => {
    // What `path.win32.relative('C:/repo', 'D:/elsewhere/doc.md')` returns:
    // there is no relative route between drives, so the answer is the target
    // itself, absolute. It contains no `..` at all.
    expect(escapesCorpusRoot('D:/elsewhere/doc.md')).toBe(true);
    expect(escapesCorpusRoot(String.raw`D:\elsewhere\doc.md`)).toBe(true);
  });

  it('refuses a UNC path and a POSIX-absolute path', () => {
    // The other two shapes `isAbsoluteAnyPlatform` covers. A network share is
    // as far outside a corpus root as another drive is.
    expect(escapesCorpusRoot(String.raw`\\host\share\doc.md`)).toBe(true);
    expect(escapesCorpusRoot('/etc/passwd')).toBe(true);
  });

  it('does not refuse a path that merely CONTAINS a drive-shaped segment', () => {
    // A basename with a colon is legal on POSIX and is not an escape. This is
    // what keeps the drive test a prefix test rather than a substring search.
    expect(escapesCorpusRoot('docs/D:notes.md')).toBe(false);
  });
});

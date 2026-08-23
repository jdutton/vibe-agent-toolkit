/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { mkdtempSync, writeFileSync } from 'node:fs';

import {
  createSymlink,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  type SymlinkCapability,
  symlinkCapability,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  ResourceIdentityMap,
  canonicalPathFor,
  mintResourceId,
  resolveRootPath,
  rootIdFor,
} from '../src/projection/identity.js';

// Hoisted: sonarjs/no-duplicate-string blocks a literal used 3+ times.
const DOC_RELATIVE = 'docs/readme.md';
// A path that need not exist — rootIdFor hashes a spelling, it does not read.
const ROOT_A = '/vat-corpus/a';
const TMP_PREFIX = 'vat-identity-';
const DOC_CONTENT = '# doc\n';
const ALIAS_NAME = 'alias.md';

/** A fresh temp root with `docs/` created. */
function makeRoot(): string {
  const root = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), TMP_PREFIX)));
  mkdirSyncReal(safePath.join(root, 'docs'));
  return root;
}

/** A fresh root holding one doc and a symlink that is a second name for it. */
function makeAliasedDoc(cap: SymlinkCapability): { root: string; target: string; alias: string } {
  const root = makeRoot();
  const target = safePath.join(root, DOC_RELATIVE);
  writeFileSync(target, DOC_CONTENT);
  const alias = safePath.join(root, ALIAS_NAME);
  createSymlink(cap, target, alias);
  return { root, target, alias };
}

describe('rootIdFor', () => {
  it('is deterministic for the same absolute path', () => {
    expect(rootIdFor(ROOT_A)).toBe(rootIdFor(ROOT_A));
  });

  it('differs between two roots, so a federated query stays unambiguous', () => {
    expect(rootIdFor(ROOT_A)).not.toBe(rootIdFor('/vat-corpus/b'));
  });

  it('is insensitive to a trailing separator', () => {
    expect(rootIdFor(`${ROOT_A}/`)).toBe(rootIdFor(ROOT_A));
  });
});

describe('mintResourceId', () => {
  it('is a pure function of (rootId, canonicalPath) — the same pair always mints the same id', () => {
    const rootId = rootIdFor(ROOT_A);
    expect(mintResourceId(rootId, DOC_RELATIVE)).toBe(mintResourceId(rootId, DOC_RELATIVE));
  });

  it('does NOT hash the observing zone: two extents observing one path agree', () => {
    // This is the §4.1 regression guard. There is no zone parameter to pass,
    // and that absence is the fix — an id that hashed the origin zone was
    // undefined under simultaneous membership and phase-dependent across
    // vat build's two populations.
    const rootId = rootIdFor(ROOT_A);
    const fromFilesystemExtent = mintResourceId(rootId, DOC_RELATIVE);
    const fromGitExtent = mintResourceId(rootId, DOC_RELATIVE);
    expect(fromFilesystemExtent).toBe(fromGitExtent);
  });

  it('separates the root from the path so no concatenation collision exists', () => {
    expect(mintResourceId('ab', 'c/d.md')).not.toBe(mintResourceId('a', 'bc/d.md'));
  });
});

describe('canonicalPathFor', () => {
  it('resolves a symlink to its target WHERE NO GIT TRACKER ANSWERS, so both share one identity there', ({ skip }) => {
    // ⚠️ The name states the NON-GIT branch, and only that branch. The context
    // below carries no `gitTracker`, so `canonicalPathFor` cannot take its git
    // branch and falls through to `realPathOrSelf`. Wherever git lists the path
    // the link and its target mint TWO ids — pinned as `distinctResourceIds()
    // === 3` by `projection-git-extent-symlink.test.ts`, and explained under
    // *"🪤 A symlink and its target do NOT reliably share one identity"* in
    // `../src/projection/identity.ts`. Do not read this green test as the
    // general rule.
    //
    // Creating a symlink on Windows needs the privilege Developer Mode grants,
    // which most dev boxes lack — `symlinkSync` throws EPERM there. Skip loudly
    // rather than no-op: a silently skipped symlink case reads as a pass.
    const cap = symlinkCapability() ?? skip();
    const { root, target, alias } = makeAliasedDoc(cap);
    const context = { realRoot: resolveRootPath(root) };

    expect(canonicalPathFor(alias, context)).toBe(canonicalPathFor(target, context));
  });

  it('returns a root-relative forward-slashed path', () => {
    const root = makeRoot();
    writeFileSync(safePath.join(root, DOC_RELATIVE), DOC_CONTENT);

    expect(canonicalPathFor(safePath.join(root, DOC_RELATIVE), { realRoot: resolveRootPath(root) }))
      .toBe(DOC_RELATIVE);
  });

  it('falls back to the requested path when the target cannot be resolved', () => {
    const root = makeRoot();
    expect(canonicalPathFor(safePath.join(root, 'missing.md'), { realRoot: resolveRootPath(root) }))
      .toBe('missing.md');
  });

  it('mints the same path from a root spelled unresolved, once reduced', () => {
    // The guard on the `realRoot` contract: `makeRoot` returns a `mkdtemp` path
    // under a symlinked `/var` on macOS, so the reduction is load-bearing rather
    // than cosmetic. Passing the raw root here would relativize against the
    // wrong base and yield an absolute path instead of `docs/readme.md` — which
    // is exactly the silent failure the field's name is meant to prevent.
    const root = makeRoot();
    writeFileSync(safePath.join(root, DOC_RELATIVE), DOC_CONTENT);
    const target = safePath.join(root, DOC_RELATIVE);

    expect(canonicalPathFor(target, { realRoot: resolveRootPath(`${root}/`) })).toBe(DOC_RELATIVE);
  });

  it('canonicalizes an absent file through a symlinked PARENT, so its identity will not move when it appears', ({ skip }) => {
    // A `files:`-declared build artifact reached through a symlinked directory.
    // Resolving only the whole path gives up the moment the leaf is missing and
    // would mint `link/artifact.md`; the file appearing later would then mint
    // `docs/artifact.md` — two identities for one future file.
    const cap = symlinkCapability() ?? skip();
    const root = makeRoot();
    const link = safePath.join(root, 'link');
    createSymlink(cap, safePath.join(root, 'docs'), link);

    expect(canonicalPathFor(safePath.join(link, 'artifact.md'), { realRoot: resolveRootPath(root) }))
      .toBe('docs/artifact.md');
  });
});

describe('ResourceIdentityMap', () => {
  it('returns one id for two names of one file WHEN CONSTRUCTED WITHOUT A GIT TRACKER', ({ skip }) => {
    // ⚠️ NON-GIT branch only, for the same reason as the `canonicalPathFor` case
    // above: `new ResourceIdentityMap(root)` is constructed with no `GitTracker`,
    // so nothing can supply git's spelling and `realPathOrSelf` reduces both
    // names. Given a usable tracker the two names mint two ids — see the trap
    // note on `canonicalPathFor` in `../src/projection/identity.ts`.
    const cap = symlinkCapability() ?? skip();
    const { root, target, alias } = makeAliasedDoc(cap);

    const map = new ResourceIdentityMap(root);
    expect(map.idFor(alias)).toBe(map.idFor(target));
    expect(map.size).toBe(1);
  });

  it('round-trips an id back to the canonical path that minted it', () => {
    const root = makeRoot();
    writeFileSync(safePath.join(root, DOC_RELATIVE), DOC_CONTENT);

    const map = new ResourceIdentityMap(root);
    const id = map.idFor(safePath.join(root, DOC_RELATIVE));
    expect(map.canonicalPathOf(id)).toBe(DOC_RELATIVE);
  });

  it('scopes every id to its root, so two corpora never collide', () => {
    const rootOne = makeRoot();
    const rootTwo = makeRoot();
    writeFileSync(safePath.join(rootOne, DOC_RELATIVE), DOC_CONTENT);
    writeFileSync(safePath.join(rootTwo, DOC_RELATIVE), DOC_CONTENT);

    const mapOne = new ResourceIdentityMap(rootOne);
    const mapTwo = new ResourceIdentityMap(rootTwo);

    expect(mapOne.rootId).not.toBe(mapTwo.rootId);
    expect(mapOne.idFor(safePath.join(rootOne, DOC_RELATIVE)))
      .not.toBe(mapTwo.idFor(safePath.join(rootTwo, DOC_RELATIVE)));
  });
});

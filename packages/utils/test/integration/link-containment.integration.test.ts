/**
 * `refuseEscapingLinks`: the one rule for a tree whose links are KEPT (a cloned repository, a
 * directory an operator installs from) — no link in it may lead outside it, judged on real paths
 * and on the link's own text.
 */
import { readlinkSync } from 'node:fs';
import { sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FS_FAULT_CODE } from '../../src/errors/fs-fault.js';
import { isVatError } from '../../src/errors/vat-error.js';
import { canonicalPath } from '../../src/path-containment.js';
import { safePath } from '../../src/path-core.js';
import { mkdirSyncReal } from '../../src/path-utils.js';
import { createSymlink, symlinkCapability, type SymlinkCapability } from '../../src/test-helpers.js';
import { installFaultFs } from '../../src/testing/fault-fs.js';
import { COPY_LINK_ESCAPES_SOURCE_CODE } from '../../src/tree-change/followed-walk.js';
import { HOST_PATH_FLAVOR } from '../../src/tree-change/link-chain.js';
import { kernelRefusal, refuseEscapingLinks } from '../../src/tree-change/link-containment.js';

import { plant, treeChangeSuite } from './tree-change-test-kit.js';

const suite = treeChangeSuite('link-containment-');

const NAMED = { placement: 'in-place', side: 'source', flavor: HOST_PATH_FLAVOR, tree: 'the skill directory', within: 'it', consequence: 'An install would hold a link to files the skill does not own' } as const;

/**
 * A unit holding a real directory `real` whose link `x` climbs out of the unit to a path that does
 * not exist, and an alias `<aliasTop>/z2/z3/z4/z5/L -> real`, deep enough that the same text, read
 * from the alias's spelling of `real`, stays inside. Whichever the walk meets first, `x` leads out.
 */
function aliasedClimb(skip: () => never, aliasTop: string): string {
  const { cap, unit } = fixture(skip);
  const real = safePath.join(unit, 'real');
  const deep = safePath.join(unit, aliasTop, 'z2', 'z3', 'z4', 'z5');
  mkdirSyncReal(real, { recursive: true });
  mkdirSyncReal(deep, { recursive: true });
  createSymlink(cap, '../../../../no-such-place/id_rsa', safePath.join(real, 'x'), 'file');
  createSymlink(cap, '../../../../../real', safePath.join(deep, 'L'), 'dir');
  return unit;
}

/** A tree `unit` beside a directory `outside` that it does not hold. */
function fixture(skip: () => never): { cap: SymlinkCapability; unit: string; outside: string } {
  const cap = symlinkCapability() ?? skip();
  const root = suite.root();
  const unit = safePath.join(root, 'unit');
  const outside = safePath.join(root, 'outside');
  plant(unit, { 'SKILL.md': '# skill', 'docs/a.md': 'a' });
  plant(outside, { 'key.txt': 'secret' });
  return { cap, unit, outside };
}

const check = (unit: string): void => refuseEscapingLinks({ root: unit, ...NAMED });

function refusalOf(work: () => void): Error {
  try {
    work();
  } catch (error) {
    expect(isVatError(error, COPY_LINK_ESCAPES_SOURCE_CODE), String(error)).toBe(true);
    return error as Error;
  }
  throw new Error('expected a refusal');
}

describe('refuseEscapingLinks', () => {
  it('accepts a tree with no link, and one whose links stay inside it', ({ skip }) => {
    const { cap, unit } = fixture(skip);
    expect(() => check(unit)).not.toThrow();
    createSymlink(cap, 'docs', safePath.join(unit, 'alias'), 'dir');
    createSymlink(cap, '../SKILL.md', safePath.join(unit, 'docs', 'up.md'), 'file');
    expect(() => check(unit)).not.toThrow();
  });

  it('refuses an absolute link out of the tree, naming it relative to the tree', ({ skip }) => {
    const { cap, unit, outside } = fixture(skip);
    const keys = safePath.join(unit, 'docs', 'keys');
    createSymlink(cap, outside, keys, 'dir');

    const refusal = refusalOf(() => check(unit));

    // The link's text as the OS stored it: Windows keeps an absolute target in its own separators.
    expect(refusal.message).toContain(`Refusing the skill directory: docs/keys is a symbolic link whose target leads through an absolute path (${readlinkSync(keys)})`);
    expect(refusal.message).toContain(NAMED.consequence);
  });

  // In place too, the text is judged before the kernel resolves it — and an absolute text is
  // refused unresolved, wherever it points: resolving it is the act that must not happen first.
  it('refuses an absolute link in place even when it points inside the tree', ({ skip }) => {
    const { cap, unit } = fixture(skip);
    createSymlink(cap, safePath.join(unit, 'docs', 'a.md'), safePath.join(unit, 'pinned.md'), 'file');

    expect(refusalOf(() => check(unit)).message).toContain('pinned.md is a symbolic link whose target leads through an absolute path');
  });

  it('refuses a relative link that climbs out of the tree', ({ skip }) => {
    const { cap, unit } = fixture(skip);
    createSymlink(cap, '../../outside', safePath.join(unit, 'docs', 'keys'), 'dir');
    expect(refusalOf(() => check(unit)).message).toContain('docs/keys');
  });

  it('refuses a DANGLING link aimed outside: its text names a path the tree does not own', ({ skip }) => {
    const { cap, unit } = fixture(skip);
    createSymlink(cap, '../../not-there', safePath.join(unit, 'gone'), 'file');
    expect(refusalOf(() => check(unit)).message).toContain('gone');
  });

  it('accepts a dangling link aimed inside', ({ skip }) => {
    const { cap, unit } = fixture(skip);
    createSymlink(cap, 'not-there.md', safePath.join(unit, 'gone'), 'file');
    expect(() => check(unit)).not.toThrow();
  });

  it('follows a link that stays inside, so a second hop out is still found', ({ skip }) => {
    const { cap, unit } = fixture(skip);
    const sibling = safePath.join(unit, 'sibling');
    mkdirSyncReal(sibling, { recursive: true });
    createSymlink(cap, '../../outside', safePath.join(sibling, 'hop'), 'dir');
    // Only reached through `docs/via`: the walk starts at `docs`, below `sibling`.
    createSymlink(cap, '../sibling', safePath.join(unit, 'docs', 'via'), 'dir');

    expect(refusalOf(() => refuseEscapingLinks({ root: unit, subtree: safePath.join(unit, 'docs'), ...NAMED })).message).toContain('hop');
  });

  // A link is judged where it REALLY lives. Read through an in-tree alias of its directory, the
  // same dangling text resolved inside the tree — and the directory, once visited by the alias,
  // was never walked at its real path. Both walk orders: an alias sorting before and after `real`.
  it.for(['a-alias', 'z-alias'])('refuses a dangling climb-out reached through the in-tree alias %s first or last', (aliasTop, { skip }) => {
    const unit = aliasedClimb(skip, aliasTop);

    expect(refusalOf(() => check(unit)).message).toContain('real/x is a symbolic link to a path outside it');
  });

  describe('a tree that will be relocated', () => {
    const relocated = (unit: string): void => refuseEscapingLinks({ root: unit, ...NAMED, placement: 'relocated' });

    // `up` resolves to the unit's root, so the kernel reads `up/../../..` as three levels ABOVE it —
    // nothing is there, the link dangles, and its real path is its own spelling. A lexical resolve
    // cancels `up/..` and calls the target inside. Once the tree is copied, it is not.
    it('refuses a link that climbs out THROUGH another link and dangles at the source', ({ skip }) => {
      const { cap, unit } = fixture(skip);
      const deep = safePath.join(unit, 'deep', 'a');
      mkdirSyncReal(deep, { recursive: true });
      createSymlink(cap, '../..', safePath.join(deep, 'up'), 'dir');
      createSymlink(cap, 'up/../../../.ssh/id_rsa', safePath.join(deep, 'l'), 'file');

      expect(refusalOf(() => relocated(unit)).message).toContain('deep/a/l is a symbolic link whose target passes through another symbolic link (deep/a/up)');
    });

    it('refuses a link through another link even when it lands inside', ({ skip }) => {
      const { cap, unit } = fixture(skip);
      createSymlink(cap, 'docs', safePath.join(unit, 'alias'), 'dir');
      createSymlink(cap, 'alias/a.md', safePath.join(unit, 'via.md'), 'file');

      expect(refusalOf(() => relocated(unit)).message).toContain('via.md is a symbolic link whose target passes through another symbolic link (alias)');
    });

    // Inside at the source, by the unit's own directory name — which an install need not keep.
    it('refuses a link that leaves the tree and comes back in by its name', ({ skip }) => {
      const { cap, unit } = fixture(skip);
      const self = safePath.join(unit, 'self.md');
      createSymlink(cap, '../unit/SKILL.md', self, 'file');

      // In place too: the walk never rises above the root, not even to come back in by its name.
      expect(refusalOf(() => check(unit)).message).toContain(`self.md is a symbolic link to a path outside it (${readlinkSync(self)})`);
      expect(refusalOf(() => relocated(unit)).message).toContain('self.md is a symbolic link to a path outside it');
    });

    it('refuses a link that dangles, though its text stays inside', ({ skip }) => {
      const { cap, unit } = fixture(skip);
      createSymlink(cap, 'not-there.md', safePath.join(unit, 'gone'), 'file');

      // The control: read in place, a link to nothing reads nothing.
      expect(() => check(unit)).not.toThrow();
      expect(refusalOf(() => relocated(unit)).message).toContain('gone is a symbolic link to nothing (not-there.md does not exist)');
    });

    // To the POSIX kernel a backslash is an ordinary character in a name: `a\b\c\d\e` is ONE
    // directory, so the text below climbs five levels from it — out of the unit — where a walk that
    // split on the backslash saw five real directories and five steps back down them. POSIX only:
    // on win32 a backslash IS the separator, and a directory of that name cannot exist.
    describe.skipIf(sep !== '/')('a backslash in a link\'s text is a name character, as the kernel reads it', () => {
      const ONE_NAME = String.raw`a\b\c\d\e`;

      it('refuses a link that climbs out past a directory NAMED with backslashes', ({ skip }) => {
        const { cap, unit } = fixture(skip);
        plant(unit, { 'd/a/b/c/d/e/keep': '', [`d/${ONE_NAME}/keep`]: '', 'd/.ssh/id_rsa': 'decoy' });
        createSymlink(cap, `${ONE_NAME}/../../../../../.ssh/id_rsa`, safePath.join(unit, 'd', 'l'), 'file');

        expect(refusalOf(() => relocated(unit)).message).toContain('d/l is a symbolic link');
      });

      // The walk's own lock, alone: this text resolves INSIDE the unit at the source (it comes back in
      // by the unit's name), so only reading the text as the kernel does — one name, three steps up —
      // sees that it left.
      it('refuses one that leaves and re-enters by the unit\'s name, past a name holding backslashes', ({ skip }) => {
        const { cap, unit } = fixture(skip);
        const name = String.raw`a\b\c`;
        plant(unit, { 'd/a/b/c/keep': '', [`d/${name}/keep`]: '', 'd/unit/SKILL.md': 'decoy' });
        createSymlink(cap, `${name}/../../../unit/SKILL.md`, safePath.join(unit, 'd', 'l'), 'file');

        expect(refusalOf(() => relocated(unit)).message).toContain('d/l is a symbolic link to a path outside it');
      });
    });

    // The kernel's own answer, as the second lock: two links that point at each other each "exist"
    // to a walk of the text, and resolve to nothing. That is a refusal of the link, not a filesystem fault.
    it('refuses a link the kernel cannot resolve (a cycle), as a link to nothing', ({ skip }) => {
      const { cap, unit } = fixture(skip);
      createSymlink(cap, 'pong', safePath.join(unit, 'ping'), 'file');
      createSymlink(cap, 'ping', safePath.join(unit, 'pong'), 'file');

      expect(refusalOf(() => relocated(unit)).message).toMatch(/p[io]ng is a symbolic link to nothing \(p[io]ng does not resolve: ELOOP\)/);
    });

    it('accepts a link into a sibling directory of the tree, and one to a directory', ({ skip }) => {
      const { cap, unit } = fixture(skip);
      plant(unit, { 'shared/b.md': 'b' });
      createSymlink(cap, '../shared/b.md', safePath.join(unit, 'docs', 'a-link.md'), 'file');
      createSymlink(cap, '../shared', safePath.join(unit, 'docs', 'shared'), 'dir');

      expect(() => relocated(unit)).not.toThrow();
    });

    it('refuses a link whose text is absolute, even one that points inside the tree', ({ skip }) => {
      const { cap, unit } = fixture(skip);
      createSymlink(cap, safePath.join(unit, 'docs', 'a.md'), safePath.join(unit, 'pinned.md'), 'file');

      expect(refusalOf(() => relocated(unit)).message).toContain('pinned.md is a symbolic link with an absolute target');
    });

    it('still accepts a relative link that stays inside', ({ skip }) => {
      const { cap, unit } = fixture(skip);
      createSymlink(cap, '../SKILL.md', safePath.join(unit, 'docs', 'up.md'), 'file');
      expect(() => relocated(unit)).not.toThrow();
    });

    // The kernel lock ALONE, the walk out of the way: with a correct walk, a link the kernel resolves
    // outside never reaches this check from a real tree — so only a direct call can show it refuses.
    it('the kernel check alone refuses a link that resolves outside the tree, and passes one inside', ({ skip }) => {
      const { cap, unit, outside } = fixture(skip);
      const root = canonicalPath(unit, unit);
      const out = safePath.join(root, 'out.txt');
      const inside = safePath.join(root, 'in.md');
      createSymlink(cap, safePath.join(outside, 'key.txt'), out, 'file');
      createSymlink(cap, 'SKILL.md', inside, 'file');
      const relocatedCheck = { root: unit, ...NAMED, placement: 'relocated' } as const;

      expect(kernelRefusal(relocatedCheck, root, inside, 'SKILL.md')).toBeUndefined();
      expect(kernelRefusal(relocatedCheck, root, out, 'the-text')).toBe('to a path outside it (the-text resolves outside it)');
    });

    // The kernel lock alone on a link that does not resolve: what it says is the kernel's errno, not the walk's reading.
    it.for([
      ['a dangling link', 'missing.md', 'ENOENT'],
      ['a link to itself', 'self.md', 'ELOOP'],
    ] as const)('the kernel check alone refuses %s as a link to nothing, naming the errno', ([, target, code], { skip }) => {
      const { cap, unit } = fixture(skip);
      const root = canonicalPath(unit, unit);
      const link = safePath.join(root, 'self.md');
      createSymlink(cap, target, link, 'file');
      const relocatedCheck = { root: unit, ...NAMED, placement: 'relocated' } as const;

      expect(kernelRefusal(relocatedCheck, root, link, 'the-text')).toBe(`to nothing (the-text does not resolve: ${code}), so where it would lead once it is copied cannot be shown`);
    });

    // A link that does not resolve is the link's refusal; the OS refusing to look is a fault on the
    // operator's tree, thrown CLASSIFIED (the one link predicate's write lane) — never "a link to nothing".
    it('throws a refused probe of the link\'s target as a classified source fault, not as a link to nothing', ({ skip }) => {
      const { cap, unit } = fixture(skip);
      const link = safePath.join(canonicalPath(unit, unit), 'docs', 'up.md');
      createSymlink(cap, '../SKILL.md', link, 'file');
      const session = installFaultFs({ within: canonicalPath(unit, unit), faults: [{ op: 'stat', path: (path) => path === link, errno: 'EACCES' }] });
      try {
        expect(() => relocated(unit)).toThrow(expect.objectContaining({ code: FS_FAULT_CODE, errno: 'EACCES', side: 'source', path: link }));
        expect(session.fired.length).toBeGreaterThan(0);
      } finally {
        session.restore();
      }
    });
  });

  it('survives a cycle of links inside the tree', ({ skip }) => {
    const { cap, unit } = fixture(skip);
    createSymlink(cap, '..', safePath.join(unit, 'docs', 'loop'), 'dir');
    expect(() => check(unit)).not.toThrow();
  });

  it('never enters the directory it is told to skip', ({ skip }) => {
    const { cap, unit, outside } = fixture(skip);
    const skipped = safePath.join(unit, '.git');
    mkdirSyncReal(skipped, { recursive: true });
    createSymlink(cap, outside, safePath.join(skipped, 'objects'), 'dir');

    expect(() => refuseEscapingLinks({ root: unit, skip: skipped, ...NAMED })).not.toThrow();
    expect(refusalOf(() => check(unit)).message).toContain('.git/objects');
  });
});

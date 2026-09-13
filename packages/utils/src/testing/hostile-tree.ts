/**
 * One hostile fixture tree, built the same way for every sink.
 *
 * A correctness sweep found a delete, a copy and an uninstall that
 * each walked out of their root, and found them by hand-building the same
 * shapes — a symlink pointing out, a symlink pointing back at the root, a
 * `..`-named entry, an unreadable directory, a traversal name — one throwaway
 * fixture per probe. This module
 * is that fixture, once, so a sink's test says `buildHostileTree(base)` and
 * `it.each(HOSTILE_NAMES)` and is refusing the shapes the next sink's test is
 * refusing too. A shape added here reaches every sink that uses it.
 *
 * ⛔ Framework-free, like everything under `testing/`: no `vitest` import, so
 * the `./testing` subpath keeps the empty third-party set its purity pin
 * asserts. Fields that the host cannot build are `null` — route those through
 * the suite's own `skip()` so the skip is visible in the report.
 */

import { chmodSync, rmSync, writeFileSync } from 'node:fs';

import { isFilesystemAccessError } from '../fs-utils.js';
import { mkdirSyncReal, safePath } from '../path-utils.js';
import { createSymlink, symlinkCapability, type SymlinkCapability } from '../test-helpers.js';

import { CANNOT_DENY_READS } from './platform-gates.js';
import { createTempDir, removeTempDir } from './temp-dir.js';


/** The names a sink must refuse when they arrive as "the entry to act on". */
export const HOSTILE_NAMES: readonly string[] = [
  '..',
  '../victim',
  '../../victim',
  'a/../../victim',
  String.raw`..\victim`,
  '.',
  '',
  '/victim',
  String.raw`C:\victim`,
  `nul${String.fromCodePoint(0)}byte`,
];

/** The tree {@link buildHostileTree} plants, every path absolute and forward-slashed. */
export interface HostileTree {
  /** The trusted root — the directory a sink must stay inside. */
  readonly root: string;
  /** A regular directory under the root; `root/member`. */
  readonly member: string;
  /** A member whose NAME begins with two dots; `root/..cache`. Legitimate. */
  readonly dotdotNamed: string;
  /** A sibling of the root, outside it. */
  readonly outside: string;
  /** `outside/victim` — holds `secret.txt`; a traversal that succeeds deletes or copies this. */
  readonly victim: string;
  /** `root/link-out` → `outside/victim`, or `null` where the host cannot symlink. */
  readonly linkOut: string | null;
  /** `root/link-in` → `root/member`, or `null` where the host cannot symlink. */
  readonly linkIn: string | null;
  /** `root/dangling` → a path that does not exist, or `null` where the host cannot symlink. */
  readonly dangling: string | null;
  /** `root/loop` → `root` itself — a walk that follows it never ends — or `null` where the host cannot symlink. */
  readonly linkLoop: string | null;
  /** A link OUTSIDE the tree that points AT the root, or `null` where the host cannot symlink. */
  readonly rootAlias: string | null;
  /** `root/unreadable`, mode 000, or `null` where the host cannot deny reads. */
  readonly unreadable: string | null;
  /** A directory whose own name is 200 characters, under the root; `null` where the OS refused it. */
  readonly longPath: string | null;
  /** Restore modes and remove everything this call created. Idempotent. */
  cleanup(): void;
}

/** A link, or `null` when this host cannot make one (the capability probe said so). */
function tryLink(cap: SymlinkCapability | null, target: string, link: string, type: 'dir' | 'file'): string | null {
  if (cap === null) return null;
  createSymlink(cap, target, link, type);
  return link;
}

function tryMkdir(dir: string): string | null {
  try {
    mkdirSyncReal(dir);
    return dir;
  } catch (error) {
    // Only a name the OS will not take is "cannot build" — `ENAMETOOLONG` on
    // a host with a shorter limit. Anything else is a broken fixture.
    if (error instanceof Error && 'code' in error && error.code === 'ENAMETOOLONG') {
      return null;
    }
    throw error;
  }
}

/**
 * Plant the hostile tree under `base`, which must exist and be empty enough
 * to take `root`, `outside` and `root-alias` as direct children.
 *
 * @param base - A scratch directory the caller owns (a per-test temp dir)
 * @returns The tree, with `null` for every shape this host cannot build
 */
export function buildHostileTree(base: string): HostileTree {
  const root = safePath.join(base, 'root');
  const member = safePath.join(root, 'member');
  const dotdotNamed = safePath.join(root, '..cache');
  const outside = safePath.join(base, 'outside');
  const victim = safePath.join(outside, 'victim');

  mkdirSyncReal(member, { recursive: true });
  mkdirSyncReal(safePath.join(root, 'nested', 'deep'), { recursive: true });
  mkdirSyncReal(dotdotNamed);
  mkdirSyncReal(victim, { recursive: true });
  writeFileSync(safePath.join(victim, 'secret.txt'), 'TOKEN=abc\n');
  writeFileSync(safePath.join(member, 'file.txt'), 'member\n');

  const cap = symlinkCapability();
  const linkOut = tryLink(cap, victim, safePath.join(root, 'link-out'), 'dir');
  const linkIn = tryLink(cap, member, safePath.join(root, 'link-in'), 'dir');
  const dangling = tryLink(cap, safePath.join(root, 'does-not-exist'), safePath.join(root, 'dangling'), 'file');
  const linkLoop = tryLink(cap, root, safePath.join(root, 'loop'), 'dir');
  const rootAlias = tryLink(cap, root, safePath.join(base, 'root-alias'), 'dir');

  let unreadable: string | null = null;
  if (!CANNOT_DENY_READS) {
    unreadable = safePath.join(root, 'unreadable');
    mkdirSyncReal(unreadable);
    writeFileSync(safePath.join(unreadable, 'hidden.txt'), 'x');
    chmodSync(unreadable, 0o000);
  }

  const longPath = tryMkdir(safePath.join(root, 'L'.repeat(200)));

  let cleaned = false;
  return {
    root,
    member,
    dotdotNamed,
    outside,
    victim,
    linkOut,
    linkIn,
    dangling,
    linkLoop,
    rootAlias,
    unreadable,
    longPath,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      if (unreadable !== null) {
        try {
          chmodSync(unreadable, 0o700);
        } catch (error) {
          // Already removed by the subject under test, which a delete sink is
          // entitled to do; a refusal to restore anything else stays loud.
          if (!isFilesystemAccessError(error)) throw error;
        }
      }
      for (const dir of [root, outside, rootAlias]) {
        if (dir !== null) rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** A hostile tree replanted per test, driven from the suite's own hooks. */
export interface HostileTreePerTest {
  /** Mint a scratch root and plant a fresh tree in it. Drive from `beforeEach`. */
  plant: () => void;
  /** Tear the tree down and remove the scratch root. Drive from `afterEach`. */
  clear: () => void;
  /** The tree planted by the most recent {@link HostileTreePerTest.plant}. */
  tree: () => HostileTree;
}

/**
 * Hold a per-test hostile tree, so a suite's wiring is three lines:
 * `const hostile = hostileTreePerTest('x'); beforeEach(hostile.plant); afterEach(hostile.clear);`.
 *
 * Same shape and same reasons as `replantableCorpus`: the tree comes back
 * through a GETTER because it is reminted per test, `plant` clears any tree
 * still standing so nested `describe`s do not leak one, and `tree()` before
 * `plant()` throws by name rather than surfacing as an undefined read.
 *
 * @param prefix - `mkdtemp` prefix for the scratch root, so a leak names its suite
 * @returns Plant/clear/tree, to be driven from the caller's own hooks
 */
export function hostileTreePerTest(prefix: string): HostileTreePerTest {
  let scratch: string | undefined;
  let planted: HostileTree | undefined;
  const clear = (): void => {
    planted?.cleanup();
    planted = undefined;
    if (scratch !== undefined) removeTempDir(scratch);
    scratch = undefined;
  };
  return {
    plant: () => {
      clear();
      scratch = createTempDir(prefix);
      planted = buildHostileTree(scratch);
    },
    clear,
    tree: () => {
      if (planted === undefined) {
        throw new Error(`hostileTreePerTest('${prefix}'): tree() before plant() — the suite is missing its beforeEach`);
      }
      return planted;
    },
  };
}

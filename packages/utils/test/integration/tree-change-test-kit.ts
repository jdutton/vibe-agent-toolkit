/**
 * Shared scaffolding for the tree-change apply suites: a scratch root per test,
 * a fault session torn down after it, trees planted from a path → content map, and
 * the one assertion every failure path owes — the root is byte-equal to before.
 *
 * ⛔ Every suite here exercises remove, chmod and dispose paths, and a red-proof run
 * deletes a guard to watch them fail. So before each test `TMPDIR` / `TEMP` / `TMP`
 * are pointed at a fresh scratch directory, and every root, `withTempDir` and
 * `normalizedTmpdir()` lives under it: no test, and no mutation of the code under
 * test, can reach the real temp directory or anything else of the user's.
 */

import { chmodSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, beforeEach, expect, vi } from 'vitest';

import { isPathAbsentError } from '../../src/errors/errno-table.js';
import { promised } from '../../src/in-order.js';
import { safePath } from '../../src/path-core.js';
import { mkdirSyncReal } from '../../src/path-utils.js';
import { installFaultFs, type FaultFsSession, type StatRewrite } from '../../src/testing/fault-fs.js';
import type { FaultRule } from '../../src/testing/fault-spec.js';
import { createTempDir, removeTempDir } from '../../src/testing/temp-dir.js';
import { diffSnapshots, snapshotTree, type TreeSnapshot } from '../../src/testing/tree-snapshot.js';
import { applyTreePlan, type ApplyOptions } from '../../src/tree-change/apply.js';
import type { TreeChange, TreePlan } from '../../src/tree-change/plan.js';
import { isTreeChangeResidue } from '../../src/tree-change/staging-names.js';

/** Give every directory under `dir` its owner's rwx back, so a test that left a 0555 tree can still be cleaned up. */
function grantOwner(dir: string): void {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink() && entry.isDirectory()) grantOwner(safePath.join(dir, entry.name));
  }
}

/** One suite's scratch roots and fault session, both undone after every test. */
export function treeChangeSuite(prefix: string): {
  root: () => string;
  faults: (root: string, faults: readonly FaultRule[], rewrites?: readonly StatRewrite[]) => FaultFsSession;
  restoreFaults: () => void;
  failApply: (root: string, plan: TreePlan, faults: readonly FaultRule[], options?: ApplyOptions) => Promise<unknown>;
  fullStagingFault: (root: string, plan: TreePlan) => Promise<unknown>;
} {
  let session: FaultFsSession | undefined;
  let scratch: string | undefined;
  const restoreFaults = (): void => {
    session?.restore();
    session = undefined;
  };
  beforeEach(() => {
    // Made under the REAL temp directory, then made the temp directory for the test.
    scratch = createTempDir(prefix);
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, scratch);
  });
  afterEach(() => {
    restoreFaults();
    vi.unstubAllEnvs();
    if (scratch !== undefined) {
      grantOwner(scratch);
      removeTempDir(scratch);
      scratch = undefined;
    }
  });
  // Apply `plan` under `faults`: what it rejected with, the faults already restored.
  const failApply = async (root: string, plan: TreePlan, faults: readonly FaultRule[], options: ApplyOptions = {}): Promise<unknown> => {
    session = installFaultFs({ within: root, faults });
    const error = await rejectionOf(() => applyTreePlan(plan, options));
    restoreFaults();
    return error;
  };
  return {
    // Under the stubbed temp directory, so under this test's scratch.
    root: () => createTempDir('root-'),
    faults: (root, faults, rewrites = []) => {
      session = installFaultFs({ within: root, faults, rewrites });
      return session;
    },
    restoreFaults,
    failApply,
    // Apply `plan` with the disk full while staging (ENOSPC on a staged write): `root` is as it was; what it threw.
    fullStagingFault: async (root, plan) => {
      const before = snapshotTree(root);
      const error = await failApply(root, plan, [{ family: 'write', path: isStaged, errno: 'ENOSPC' }]);
      expectUnchanged(root, before);
      return error;
    },
  };
}

/** Write each `relative path → content` under `root`, making parents. */
export function plant(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const path = safePath.join(root, relative);
    mkdirSyncReal(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

export const readText = (path: string): string => readFileSync(path, 'utf-8');

/** Whether anything is at `path` (a link counts, dangling or not). */
export function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: unknown) {
    if (isPathAbsentError(error)) return false;
    throw error;
  }
}

/** The tree-change residue names directly under `dir`. */
export const residueIn = (dir: string): string[] => readdirSync(dir).filter((name) => isTreeChangeResidue(name));

/** Assert `root` now is exactly `before` — no change, no residue. */
export function expectUnchanged(root: string, before: TreeSnapshot): void {
  expect(diffSnapshots(before, snapshotTree(root))).toEqual([]);
}

/** A `replace` whose fill writes `files` into the staged tree. */
export function replaceWith(dest: string, files: Record<string, string>, label = 'new'): TreeChange {
  return { op: 'replace', dest, ownership: { kind: 'force' }, fill: { from: 'write', write: (staged) => promised(() => plant(staged, files)) }, label };
}

/** A rule failing the `nth` rename under the session root with `errno`. */
export const nthRename = (nth: number, errno: FaultRule['errno']): FaultRule => ({ family: 'rename', path: () => true, nth, errno });

/** Whether `path` is a staged tree (never its parked `.previous` twin). */
export const isStaged = (path: string): boolean => path.includes('.vat-staged-') && !path.endsWith('.previous');

/** What `work` rejected with; a resolution fails the test. */
export async function rejectionOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected a rejection');
}

/** An `lstat` rewrite giving every path `matches` accepts these `dev` / `ino`, keeping the Stats prototype (and number or bigint form). */
export function lstatAs(matches: (path: string) => boolean, ids: { readonly dev?: bigint; readonly ino: bigint }): StatRewrite {
  return {
    op: 'lstat',
    path: matches,
    rewrite: (stats) => {
      const as = (value: bigint, like: number | bigint): number | bigint => (typeof like === 'bigint' ? value : Number(value));
      const replaced = { ino: as(ids.ino, stats.ino), ...(ids.dev === undefined ? {} : { dev: as(ids.dev, stats.dev) }) };
      return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as typeof stats, stats, replaced);
    },
  };
}

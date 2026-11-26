/**
 * `vat cache prune` and the guard every cache removal stands behind.
 *
 * Every prune runs against a root this suite built inside its own scratch temp
 * directory: a test that pruned a developer's live cache would be a bug whether
 * or not it passed.
 */

import { existsSync, promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import { DEFAULT_BLOB_TIER_BUDGET_BYTES, DEFAULT_ROW_SET_TIER_BUDGET_BYTES, openSqliteFactStore } from '@vibe-agent-toolkit/projection-sqlite';
import { markVatCacheRoot, VAT_CACHE_TAG_FILE, vatCacheRoot } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recognisedCacheRoot } from '../../src/commands/cache/cache-measure.js';
import { pruneCacheRoot } from '../../src/commands/cache/prune.js';
import { storeInUse } from '../../src/utils/projection-store.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

/** The namespace and store directory a prune keeps, named once. */
const CURRENT = '0.2.0';
const KEPT_STORE = 'projection-current';
/** A store of an older projection shape, inside the current namespace. */
const OLD_STORE = 'projection-oldshape';

/** Alphabetical, spelled out so a listing's order does not depend on the default comparator. */
const byName = (left: string, right: string): number => left.localeCompare(right);

/** Write `body` at `relative` under `root`, making its parents. */
async function put(root: string, relative: string, body: string): Promise<void> {
  const file = safePath.join(root, relative);
  mkdirSyncReal(dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}

/**
 * A cache root holding the current namespace (its parse cache, its current
 * store and an old-shape store), an older namespace, and what older releases
 * kept at the root: a link-cache file and the root-level `parse/` directory.
 */
async function populatedRoot(parent: string): Promise<string> {
  const root = safePath.join(parent, 'cache');
  await put(root, VAT_CACHE_TAG_FILE, 'tag');
  await put(root, `${CURRENT}/parse/ab/facts.json`, '{"a":1}');
  await put(root, `${CURRENT}/${KEPT_STORE}/projection.db`, 'kept');
  await put(root, `${CURRENT}/${OLD_STORE}/projection.db`, 'old-db');
  await put(root, '0.1.9/parse/cd/facts.json', '{"b":22}');
  await put(root, '0.1.9/projection-x/projection.db', 'xx');
  await put(root, 'external-links.json', '{}');
  await put(root, 'parse/ef/facts.json', '{"c":3}');
  return root;
}

describe('pruneCacheRoot', () => {
  const scratch = useScratchTmpdir('vat-cache-prune-');

  it('removes other namespaces, other-shape stores and stray root entries, and keeps the rest', async () => {
    const root = await populatedRoot(scratch());

    const { data, leftover } = await pruneCacheRoot({ root, namespace: CURRENT, keptStore: KEPT_STORE, dryRun: false, storeInUse });

    expect(leftover).toBeUndefined();
    expect(data).toEqual({
      cacheDir: root,
      namespace: CURRENT,
      keptStore: `${CURRENT}/${KEPT_STORE}`,
      dryRun: false,
      removed: ['0.1.9', `${CURRENT}/${OLD_STORE}`, 'external-links.json', 'parse'],
      inUse: [],
      entriesRemoved: 5,
      bytesRemoved: 'old-db'.length + '{"b":22}'.length + 'xx'.length + '{}'.length + '{"c":3}'.length,
    });
    expect((await fs.readdir(root)).sort(byName)).toEqual([CURRENT, VAT_CACHE_TAG_FILE].sort(byName));
    expect((await fs.readdir(safePath.join(root, CURRENT))).sort(byName)).toEqual(['parse', KEPT_STORE]);
  });

  it('keeps the version-only namespace and removes every suffixed name that shares its prefix', async () => {
    const root = await populatedRoot(scratch());
    // A namespace is the VAT version alone, so a `<version>-<suffix>` name beside it is another build's
    // (a prerelease, or a name an unreleased build wrote): it shares this version's prefix and is not kept.
    const earlier = [`${CURRENT}-dev-9f2c1a`, `${CURRENT}-pabc123`, `${CURRENT}-rc.1-p0f9e8d`];
    await Promise.all(earlier.map(async (name) => put(root, `${name}/parse/ab/facts.json`, '{"s":1}')));

    const { data } = await pruneCacheRoot({ root, namespace: CURRENT, keptStore: KEPT_STORE, dryRun: false, storeInUse });

    for (const name of earlier) {
      expect(data.removed, name).toContain(name);
      expect(existsSync(safePath.join(root, name)), name).toBe(false);
    }
    expect(existsSync(safePath.join(root, CURRENT, KEPT_STORE))).toBe(true);
  });

  it('leaves every entry it does not recognise as VAT\'s, at the root and inside the namespace', async () => {
    const root = await populatedRoot(scratch());
    // A VAT_CACHE_DIR that someone else also writes into: none of this is VAT's to delete.
    const foreign = ['notes.txt', 'my-project/src/index.ts', 'node_modules/x/package.json', '.git/HEAD', `${CURRENT}/scratch-notes.md`];
    await Promise.all(foreign.map(async (relative) => put(root, relative, 'theirs')));

    const { data } = await pruneCacheRoot({ root, namespace: CURRENT, keptStore: KEPT_STORE, dryRun: false, storeInUse });

    expect(data.removed).toEqual(['0.1.9', `${CURRENT}/${OLD_STORE}`, 'external-links.json', 'parse']);
    for (const relative of foreign) {
      expect(existsSync(safePath.join(root, relative)), relative).toBe(true);
    }
  });

  it('leaves a store a running VAT holds open, and the namespace around it, and says so', async () => {
    const root = await populatedRoot(scratch());
    // Real stores, held open as another worktree's or release's VAT would hold them mid-run.
    await fs.rm(safePath.join(root, '0.1.9', 'projection-x', 'projection.db'));
    await fs.rm(safePath.join(root, CURRENT, OLD_STORE, 'projection.db'));
    const heldOld = openSqliteFactStore({ directory: safePath.join(root, '0.1.9', 'projection-x'), blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
    const heldShape = openSqliteFactStore({ directory: safePath.join(root, CURRENT, OLD_STORE), blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
    try {
      const { data } = await pruneCacheRoot({ root, namespace: CURRENT, keptStore: KEPT_STORE, dryRun: false, storeInUse });

      expect(data.removed).toEqual(['external-links.json', 'parse']);
      expect(data.inUse).toEqual(['0.1.9', `${CURRENT}/${OLD_STORE}`]);
      expect(existsSync(safePath.join(root, '0.1.9', 'parse'))).toBe(true);
      expect(existsSync(safePath.join(root, CURRENT, OLD_STORE))).toBe(true);
    } finally {
      await heldOld.close();
      await heldShape.close();
    }

    // Closed, they go on the next prune.
    const { data } = await pruneCacheRoot({ root, namespace: CURRENT, keptStore: KEPT_STORE, dryRun: false, storeInUse });
    expect(data).toMatchObject({ removed: ['0.1.9', `${CURRENT}/${OLD_STORE}`], inUse: [] });
  });

  it('under --dry-run reports the same removal and deletes nothing', async () => {
    const root = await populatedRoot(scratch());

    const { data } = await pruneCacheRoot({ root, namespace: CURRENT, keptStore: KEPT_STORE, dryRun: true, storeInUse });

    expect(data).toMatchObject({ dryRun: true, removed: ['0.1.9', `${CURRENT}/${OLD_STORE}`, 'external-links.json', 'parse'], entriesRemoved: 5 });
    expect(existsSync(safePath.join(root, '0.1.9'))).toBe(true);
    expect(existsSync(safePath.join(root, CURRENT, OLD_STORE))).toBe(true);
  });

  it('is a prune of nothing when the root is absent, or holds only what is current', async () => {
    const missing = safePath.join(scratch(), 'never-created');
    expect((await pruneCacheRoot({ root: missing, namespace: CURRENT, keptStore: KEPT_STORE, dryRun: false, storeInUse })).data).toMatchObject({ removed: [], entriesRemoved: 0, bytesRemoved: 0 });

    const current = safePath.join(scratch(), 'current-only');
    await put(current, `${CURRENT}/${KEPT_STORE}/projection.db`, 'kept');
    expect((await pruneCacheRoot({ root: current, namespace: CURRENT, keptStore: KEPT_STORE, dryRun: false, storeInUse })).data.removed).toEqual([]);
  });
});

describe('recognisedCacheRoot', () => {
  const scratch = useScratchTmpdir('vat-cache-guard-');
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[VAT_CACHE_DIR_ENV];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (saved === undefined) delete process.env[VAT_CACHE_DIR_ENV];
    else process.env[VAT_CACHE_DIR_ENV] = saved;
  });

  it('refuses a VAT_CACHE_DIR that holds files VAT did not tag, as USAGE_INVALID', async () => {
    const chosen = safePath.join(scratch(), 'my-project-files');
    await put(chosen, 'important.txt', 'keep me');
    vi.stubEnv(VAT_CACHE_DIR_ENV, chosen);

    expect(() => recognisedCacheRoot()).toThrow(expect.objectContaining({ refusal: 'USAGE_INVALID' }) as Error);
    expect(existsSync(safePath.join(chosen, 'important.txt'))).toBe(true);
  });

  it('accepts a VAT_CACHE_DIR that carries the tag VAT writes, and the default location', async () => {
    const chosen = safePath.join(scratch(), 'ci-cache');
    vi.stubEnv(VAT_CACHE_DIR_ENV, chosen);
    // A root never seen before by this process, so the per-root memo cannot stand in for the write.
    markVatCacheRoot();
    expect(recognisedCacheRoot()).toBe(vatCacheRoot());

    // The default location under a temp directory of the test's own: the machine-wide one is
    // refused in a test process (see `vatCacheRoot`).
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, scratch());
    vi.stubEnv(VAT_CACHE_DIR_ENV, '');
    expect(recognisedCacheRoot().endsWith('/.vat-cache')).toBe(true);
  });
});

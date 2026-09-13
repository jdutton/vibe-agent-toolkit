/**
 * `crawlAndResolveRegistry` memoizes ONE crawl per project root, and two
 * callers of one root may hold different `unreadable` rulings — `vat audit`
 * degrades, every other verb refuses. A registry built under `{ degrade }` is a
 * population WITH A GAP; serving it unchanged to a `'refuse'` caller would be
 * the silent shorter list the refuse ruling exists to prevent, and serving it
 * to a second `{ degrade }` caller would leave that caller's handler never told.
 * So the memo keeps the refusals beside the registry and settles them again
 * under EACH later caller's policy.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { type DirectoryRefusal, DirectoryListingRefusedError } from '@vibe-agent-toolkit/utils/crawl';
import { withReaddirSyncRefused } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { crawlAndResolveRegistry, resetPackagingRegistryCache } from '../../src/validators/packaging-validator.js';

/** Build the memo entry for `root` under `{ degrade }` while `locked` refuses to list. */
async function buildDegraded(root: string, locked: string): Promise<DirectoryRefusal[]> {
  const handed: DirectoryRefusal[] = [];
  await withReaddirSyncRefused(locked, 'EACCES', () =>
    crawlAndResolveRegistry(root, { unreadable: { degrade: (r) => { handed.push(r); } } }));
  return handed;
}

/** Every admitted resource, root-relative. */
function admittedUnder(root: string, registry: Awaited<ReturnType<typeof crawlAndResolveRegistry>>): string[] {
  return registry.getAllResources().map((r) => toForwardSlash(safePath.relative(root, r.filePath)));
}

describe('crawlAndResolveRegistry replays memoized refusals under each caller policy', () => {
  let root: string;
  let locked: string;

  // A fresh tree AND a fresh memo per case: the memo is process-wide and keyed
  // on the root, so a leftover entry would make the second case's "first build"
  // a hit on the first case's.
  beforeEach(() => {
    resetPackagingRegistryCache();
    root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-registry-memo-refusal-'));
    locked = safePath.join(root, 'docs', 'locked');
    mkdirSyncReal(safePath.join(root, 'docs', 'open'), { recursive: true });
    mkdirSyncReal(locked, { recursive: true });
    writeFileSync(safePath.join(root, 'docs', 'open', 'ok.md'), '# ok\n');
    writeFileSync(safePath.join(locked, 't.md'), '# t\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a 'refuse' caller served a degrade-built registry gets the throw the crawl would have given it", async () => {
    const handed = await buildDegraded(root, locked);
    expect(handed.map((r) => r.directory)).toEqual([toForwardSlash(locked)]);

    // The directory is readable again by now — the memo, not the filesystem, must answer.
    await expect(crawlAndResolveRegistry(root, { unreadable: 'refuse' })).rejects.toBeInstanceOf(DirectoryListingRefusedError);
    await expect(crawlAndResolveRegistry(root, { unreadable: 'refuse' })).rejects.toThrow("the directory 'docs/locked'");
  });

  it('a second { degrade } caller is told about the refusal the one crawl met', async () => {
    await buildDegraded(root, locked);

    const second: DirectoryRefusal[] = [];
    const registry = await crawlAndResolveRegistry(root, { unreadable: { degrade: (r) => { second.push(r); } } });
    expect(second.map((r) => ({ directory: r.directory, code: r.code }))).toEqual([
      { directory: toForwardSlash(locked), code: 'EACCES' },
    ]);
    // And it IS the memoized registry — the gap is the same population.
    expect(admittedUnder(root, registry)).toEqual(['docs/open/ok.md']);
  });

  it("a registry built under 'refuse' carries no refusals, so a later { degrade } caller's handler is never called", async () => {
    const first = await crawlAndResolveRegistry(root, { unreadable: 'refuse' });
    const handed: DirectoryRefusal[] = [];
    const second = await crawlAndResolveRegistry(root, { unreadable: { degrade: (r) => { handed.push(r); } } });
    expect(second).toBe(first);
    expect(handed).toEqual([]);
    expect(admittedUnder(root, first).toSorted((a, b) => a.localeCompare(b))).toEqual(['docs/locked/t.md', 'docs/open/ok.md']);
  });
});

/**
 * `vat cache clear` reclaims the projection store — by SCOPE, which is the part
 * that needs a test.
 *
 * The command deletes `<tmpdir>/.vat-cache` in its entirety and names no tenant.
 * That is the right design (a clear that enumerated tenants would go stale the
 * moment a fifth arrived) and it is also why nothing in `clear.ts` mentions the
 * store: the store is covered because `defaultStoreDirectory()` happens to
 * resolve inside the tree, and "happens to" is exactly the kind of coverage that
 * evaporates in a refactor nobody reads as related.
 *
 * It now matters much more than it did. The store is **on by default**, so every
 * adopter has one whether or not they asked for it, and it is by far the largest
 * tenant — 71 MB measured for a single 12,602-file repository. A clear that
 * quietly stopped covering it would leave the only user-invocable way to reclaim
 * that space silently not doing so.
 *
 * So this file pins the two halves separately:
 *
 * 1. **Containment** — the default store directory really is inside the tree the
 *    command targets. A pure path assertion, with no filesystem to set up and
 *    nothing to delete, which is what lets it be stated about the DEVELOPER'S
 *    real cache location rather than about a fixture standing in for it.
 * 2. **Removal** — a store-shaped tree really is removed, and its bytes really
 *    are counted. Against a fixture, because the real one must not be deleted by
 *    a test run.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { vatCacheNamespace } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clearCacheDirectory, vatCacheRoot } from '../../src/commands/cache/clear.js';

/**
 * Stand-in bytes for a database file.
 *
 * Deliberately not an empty file: `bytesRemoved` is the number the help text now
 * quotes a magnitude for, and a fixture of zero-byte files would let a clear
 * that reported `bytesRemoved: 0` pass.
 */
const DATABASE_BYTES = 'x'.repeat(4096);

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-cache-clear-store-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('vat cache clear and the projection store', () => {
  it('targets a tree that CONTAINS the default store directory', async () => {
    // The containment claim, asserted against the real locations rather than a
    // fixture — a fixture could only prove that two paths this test built are
    // nested, which is not the question. Imported lazily so the suite states
    // what it depends on: this is the one place the CLI's clear and the
    // backend's default location are compared.
    const { defaultStoreDirectory } = await import('@vibe-agent-toolkit/projection-sqlite');

    const root = toForwardSlash(vatCacheRoot());
    const store = toForwardSlash(defaultStoreDirectory());

    expect(store.startsWith(`${root}/`)).toBe(true);
    // And through the release namespace specifically, which is the segment that
    // makes one release's store invisible to the next. Without this the
    // assertion above would also hold for a store dumped at the cache root,
    // where a namespace rotation would never retire it.
    expect(store).toContain(`/${vatCacheNamespace()}/projection-`);
  });

  it('removes a projection store under the cache tree and counts its bytes', async () => {
    // The fixture mirrors the real layout — `<root>/<namespace>/projection-<digest>/
    // projection.db` plus the WAL sidecars a live store leaves — so a clear that
    // stopped at the namespace level, or skipped files it did not recognise,
    // fails here.
    const cacheDir = safePath.join(scratch, '.vat-cache');
    const storeDir = safePath.join(cacheDir, vatCacheNamespace(), 'projection-abc123');
    mkdirSyncReal(storeDir, { recursive: true });
    for (const name of ['projection.db', 'projection.db-wal', 'projection.db-shm']) {
      writeFileSync(safePath.join(storeDir, name), DATABASE_BYTES, 'utf-8');
    }

    const report = await clearCacheDirectory(cacheDir);

    expect(report.status).toBe('success');
    expect(report.existed).toBe(true);
    expect(report.removed).toEqual([vatCacheNamespace()]);
    // Three files, all of them: a clear that walked only as far as the database
    // would leave a WAL behind that a later open reads as a live journal.
    expect(report.entriesRemoved).toBe(3);
    expect(report.bytesRemoved).toBe(DATABASE_BYTES.length * 3);
    // And the directory is genuinely gone, not merely emptied — re-running is
    // the "nothing to clear" path, which is the only observation that can tell
    // the two apart from out here.
    const second = await clearCacheDirectory(cacheDir);
    expect(second.existed).toBe(false);
  });
});

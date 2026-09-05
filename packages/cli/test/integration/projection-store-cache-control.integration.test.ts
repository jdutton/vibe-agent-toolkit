/* eslint-disable security/detect-non-literal-fs-filename -- every path here is a temp tree this test owns */
/**
 * `--no-cache` / `VAT_CACHE=0` against the projection store, through the real
 * binary.
 *
 * The unit test in `test/utils/projection-store.test.ts` pins the decision;
 * this pins the CONSEQUENCE, because the decision has a spawned child between it
 * and the disk. `vat validate`, `vat verify` and `vat build` each `spawnSync`
 * the binary per phase, and the flag reaches those children only as an exported
 * environment variable — a fix that worked in-process and not across the spawn
 * would look identical to a working one from the unit test's side.
 *
 * ## 🪤 The measurement trap this file exists to avoid
 *
 * The defect was originally missed because it was checked by FILE SIZE. A
 * SQLite database allocates by page, so a store holding nothing and a store
 * holding one corpus can both be 118,784 bytes, and a `--no-cache` arm that
 * wrote a full 9.83 MB extent was read as "roughly the same size, so nothing
 * was written". Every assertion below counts ROWS, out of the file, with the
 * store's own connection closed.
 *
 * ## Isolation is `VAT_PROJECTION_STORE_DIR`
 *
 * Each arm names its own store directory. That keeps this suite off the
 * developer's live cache — `defaultStoreDirectory()` is one database per VAT
 * release, shared by every root on the machine, and a test that populated or
 * cleared it would be a bug whether or not it passed.
 *
 * 🪤 The variable is imported from the module under test rather than spelled as
 * a literal here, so a rename cannot leave this suite quietly pointing at the
 * shared default. The positive control below is the backstop: if the child
 * ignored the variable altogether, the arm that asserts rows WERE written finds
 * an empty directory and fails, rather than the "nothing was written" arms
 * passing vacuously.
 *
 * Redirecting `TMPDIR` also moves the store, and this suite used to do that. It
 * is the wrong instrument twice over: it moves every other temp consumer in the
 * child in order to move one, and the variable name differs by platform —
 * `TMPDIR` on POSIX, `TEMP` then `TMP` on Windows — so setting one is silently
 * inert on the other.
 *
 * The probes that read the store back live in
 * `test/helpers/projection-store-probe.ts`, shared with the equivalence suite.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_DIR_ENV } from '../../src/utils/projection-store.js';
import {
  contributorsCharged,
  rowsStoredUnder,
  storeFilesUnder,
} from '../helpers/projection-store-probe.js';
import { executeCli, getBinPath } from '../system/test-common.js';
import { commitTestFixture } from '../test-helpers.js';

const binPath = getBinPath(import.meta.url);

/** The lane and backend selectors, which every arm needs and neither arm varies. */
const STORE_ON = {
  VAT_RESOURCES_CRAWL: 'projection',
  VAT_PROJECTION_STORE: 'sqlite',
} as const;

let scratch: string;
let corpus: string;

beforeAll(() => {
  scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-store-cache-control-'));
  corpus = safePath.join(scratch, 'corpus');
  mkdirSyncReal(safePath.join(corpus, 'docs'), { recursive: true });
  writeFileSync(safePath.join(corpus, 'docs', 'one.md'), '# One\n\nSee [two](./two.md).\n', 'utf-8');
  writeFileSync(safePath.join(corpus, 'docs', 'two.md'), '# Two\n', 'utf-8');
  commitTestFixture(corpus);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A private store directory, so this arm's store cannot be any other arm's. */
function isolatedStoreDir(label: string): string {
  return mkdtempSync(safePath.join(scratch, `${label}-store-`));
}

/**
 * Run `vat resources validate` over the fixture corpus.
 *
 * @param storeDir - The arm's private `VAT_PROJECTION_STORE_DIR`
 * @param extra - Flags before the subcommand, and any further environment
 * @returns Nothing; the arm is judged by what landed on disk, not by stdout
 */
async function runValidate(
  storeDir: string,
  extra: { flags?: readonly string[]; env?: Record<string, string> } = {},
): Promise<void> {
  const result = await executeCli(binPath, [...(extra.flags ?? []), 'resources', 'validate'], {
    cwd: corpus,
    // The store directory is applied LAST so no caller can accidentally point an
    // arm at another arm's store through `extra.env`.
    env: { ...STORE_ON, ...extra.env, [PROJECTION_STORE_DIR_ENV]: storeDir },
  });
  // A run that crashed writes no store either, and would make every "nothing
  // was written" assertion below pass for the wrong reason.
  expect(result.status, result.stderr).toBe(0);
}

describe('the projection store under the cache controls', () => {
  it('writes rows when the store is selected and caching is on', async () => {
    // The positive control, and the reason the two arms below mean anything: a
    // selector that had stopped working would make every "no rows" assertion
    // vacuously true.
    const storeDir = isolatedStoreDir('on');

    await runValidate(storeDir);

    expect(storeFilesUnder(storeDir)).toHaveLength(1);
    expect(rowsStoredUnder(storeDir)).toBeGreaterThan(0);
  });

  it.each([
    ['the root --no-cache flag', { flags: ['--no-cache'] }],
    ['VAT_CACHE=0 in the environment', { env: { VAT_CACHE: '0' } }],
  ])('writes NO rows under %s', async (_description, extra) => {
    const storeDir = isolatedStoreDir('off');

    await runValidate(storeDir, extra);

    // No file at all is the strongest form, and the one this fix produces: the
    // store is declined before the backend is imported, so nothing creates the
    // database or its schema. The row count is asserted too, so a future change
    // that opens an empty store still fails on the thing that matters.
    expect(storeFilesUnder(storeDir)).toEqual([]);
    expect(rowsStoredUnder(storeDir)).toBe(0);
  });

  it('does not READ a store that a previous run left warm', async () => {
    // The other half, and not implied by the write arm: a run could decline to
    // write while still serving its population from a store an earlier run
    // filled, which is the same broken promise in the other direction.
    //
    // Observed through the crawl-timing dump rather than inferred: a run that
    // CONSULTS a store charges `projection-store:read`, and a run given no
    // store charges nothing under `projection-store:` at all. That is the whole
    // claim this arm makes, and it is the whole claim the tell supports —
    // `readCachedProjection` files the row in a `finally`, deliberately, so a
    // hit and a miss are charged alike. Measured on this fixture, the warm
    // `resources validate` run MISSES: it charges `projection-store:write` and
    // `builtin:filesystem` exactly as the cold run does. See the equivalence
    // suite, whose per-command `warmHitsStore` records which commands hit.
    const storeDir = isolatedStoreDir('warm');
    await runValidate(storeDir);
    expect(rowsStoredUnder(storeDir)).toBeGreaterThan(0);

    const warmTiming = mkdtempSync(safePath.join(scratch, 'timing-warm-'));
    await runValidate(storeDir, { env: { VAT_CRAWL_TIMING: warmTiming } });
    expect(contributorsCharged(warmTiming)).toContain('projection-store:read');

    const coldTiming = mkdtempSync(safePath.join(scratch, 'timing-cold-'));
    await runValidate(storeDir, { flags: ['--no-cache'], env: { VAT_CRAWL_TIMING: coldTiming } });

    const charged = contributorsCharged(coldTiming);
    expect(charged).not.toContain('projection-store:read');
    expect(charged).toContain('builtin:filesystem');
    // And the warm store is still there, untouched — `--no-cache` declines to
    // use a cache, it does not clear one. `vat cache clear` is that command.
    expect(rowsStoredUnder(storeDir)).toBeGreaterThan(0);
  });
});

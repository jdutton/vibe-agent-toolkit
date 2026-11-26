/**
 * Warm edit seeds, keys the store does not hold: a warm run after an edit extracts the edited
 * key and every key the primed store lost or never held, and serves every other from the stored
 * blob tier (the harness's `editServed` tell).
 *
 * - an evicted key: one covered key's blob rows deleted after the prime, beside a one-file edit;
 * - a symbolic link retargeted: the link is declined as a member, so its new target moves the
 *   tree and no key;
 * - a load-refused file: its parse is stopped at a limit, and that refusal is filed nowhere
 *   (`storableBlobFacts` drops it), so its key is uncovered in every store, before the measured
 *   run and after it; the seed declares it `refused`, and the tell counts its one refused parse as
 *   `parseLookupsIn` does, a dispatch plus a refusal;
 * - a submodule edit: the known gap. A submodule's files are no members until Phase 2 scans them,
 *   and the superproject's tree records its commit, not its working tree: the tree key stays, the
 *   warm run is served, and every arm agrees in not seeing the edit.
 *
 * Every edit is uncommitted: `HEAD` never moves.
 */

import { existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { deleteBlobFactsSql } from '@vibe-agent-toolkit/projection-sqlite';
import { isProjectionTable, storedRelationSpecs } from '@vibe-agent-toolkit/resources';
import { createSymlink, CRAWL_STORE_READ_ID, CRAWL_STORE_WRITE_ID, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { overOutputRowsMarkdown } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { namesPath } from '../helpers/absence-seeds.js';
import type { ArmDirs, Git, I0Seed } from '../helpers/cache-differential.js';
import { storeFilesUnder } from '../helpers/projection-store-probe.js';
import {
  appendEdit,
  contentKeyAt,
  EDIT_ARMS,
  editSeed,
  editSeedCases,
  keysMoved,
  keysOf,
  primeAndReference,
} from '../helpers/warm-edit-seeds.js';

/** The file every seed here but the link's edits, so the tree is new and the extent misses. */
const EDITED = 'docs/two.md';

/** Edit {@link EDITED}. */
function editTheFile(corpus: string): Promise<void> {
  appendEdit(corpus, EDITED);
  return Promise.resolve();
}

/** The file whose key the eviction seed deletes from the blob tier. */
const EVICTED = 'docs/one.md';

/** The blob-scoped tables: every table a blob's facts live in. */
const BLOB_TABLES = storedRelationSpecs().filter(isProjectionTable).filter((spec) => spec.scope === 'blob');

/**
 * Evict one content key as the store's own eviction does: its rows in every blob-scoped table,
 * with the store's own statement, and its `blob_keys` ledger row; assert it held both.
 *
 * @param dirs - The primed cell
 * @param key - The content key
 */
function evictKey(dirs: ArmDirs, key: string): void {
  const [file, ...others] = storeFilesUnder(dirs.store);
  if (file === undefined || others.length > 0) throw new Error(`expected one projection store under ${dirs.store}`);
  const database = new DatabaseSync(file);
  try {
    database.exec('BEGIN IMMEDIATE');
    const deleted = BLOB_TABLES.reduce((sum, spec) => sum + Number(database.prepare(deleteBlobFactsSql(spec, 1)).run(key).changes), 0);
    const ledger = Number(database.prepare('DELETE FROM "blob_keys" WHERE "contentKey" = ?').run(key).changes);
    database.exec('COMMIT');
    expect(deleted, `${EVICTED}: the prime held its blob rows`).toBeGreaterThan(0);
    expect(ledger, `${EVICTED}: the prime held its ledger row`).toBe(1);
  } finally {
    database.close();
  }
}

const evictedKey = editSeed({
  name: 'an evicted key',
  toB: (_arm, _dirs, corpus) => editTheFile(corpus),
  beforeRun: (arm, dirs, corpus) => {
    if (arm === 'warmSameHistory') evictKey(dirs, contentKeyAt(corpus, EVICTED));
    return Promise.resolve();
  },
  uncovered: (_dirs, corpus) => [contentKeyAt(corpus, EDITED), contentKeyAt(corpus, EVICTED)],
  consumed: keysMoved([EDITED]),
});

const LINK = 'docs/linked.md';

/** Point {@link LINK} at a target, replacing any link already there. */
function linkTo(corpus: string, target: string): void {
  const capability = symlinkCapability();
  if (capability === null) throw new Error('a link seed planted on a host that cannot create a symbolic link');
  rmSync(safePath.join(corpus, LINK), { force: true });
  createSymlink(capability, target, safePath.join(corpus, LINK), 'file');
}

const symlinkRetarget = editSeed({
  name: 'symlink retarget',
  needs: 'symlinks',
  stateA: (corpus, git) => {
    linkTo(corpus, 'two.md');
    git(['add', '--', LINK]);
    git(['commit', '-q', '-m', 'a link to an in-root file']);
    return Promise.resolve();
  },
  toB: (_arm, _dirs, corpus, git) => {
    linkTo(corpus, 'guide.md');
    expect(git(['status', '--porcelain', '--', LINK]).trim(), `git sees ${LINK} retargeted`).toBe(`M ${LINK}`);
    return Promise.resolve();
  },
  // A link is declined, never keyed: no key moves.
  uncovered: () => [],
  consumed: {
    runs: ['warmSameHistory:prime', 'storeOff:measured'],
    check: (runs) => {
      for (const label of ['warmSameHistory:prime', 'storeOff:measured'] as const) {
        expect(keysOf(runs, label, LINK), `${label}: ${LINK} is no member`).toEqual([]);
        expect(namesPath(runs[label]?.query?.stdout ?? '', LINK), `${label}: ${LINK} is declined by name`).toBe(true);
      }
    },
  },
});

const REFUSED = 'docs/huge.md';
/** Generated once, so every arm reads the same bytes (the generator stamps a fresh nonce per call). */
const REFUSED_TEXT = overOutputRowsMarkdown('one.md');

const loadRefused = editSeed({
  name: 'a load-refused file',
  stateA: (corpus, git) => {
    writeFileSync(safePath.join(corpus, REFUSED), REFUSED_TEXT);
    git(['add', '--', REFUSED]);
    git(['commit', '-q', '-m', 'a file over a parse limit']);
    return Promise.resolve();
  },
  toB: (_arm, _dirs, corpus) => editTheFile(corpus),
  // No store files a parse-limit refusal, so the refused key is uncovered in every store, and stays so.
  uncovered: (_dirs, corpus) => [contentKeyAt(corpus, EDITED), contentKeyAt(corpus, REFUSED)],
  refused: (_dirs, corpus) => [contentKeyAt(corpus, REFUSED)],
  consumed: primeAndReference((keysAt) => {
    expect(keysAt('storeOff:measured', REFUSED), `${REFUSED}: keyed though refused`).toEqual(keysAt('warmSameHistory:prime', REFUSED));
    expect(keysAt('storeOff:measured', REFUSED), `${REFUSED}: one realization`).toHaveLength(1);
  }),
});

const SUBMODULE = 'vendor/sub';
const SUBMODULE_FILE = `${SUBMODULE}/README.md`;
/** The submodule directory's pinned mtime. */
const SUBMODULE_MTIME = new Date('2026-01-01T00:00:00.000Z');

/** The submodule's origin, a sibling of the corpus, so `.gitmodules` names it alike in every cell. */
const ORIGIN = 'submodule-origin';

/**
 * Add a submodule to the corpus and commit it. Its origin is one repository beside the corpus,
 * made by the first cell and reused by every later one, so every cell's gitlink names one commit
 * and its `.gitmodules` one relative URL: the cells differ in nothing but the arm.
 *
 * @param corpus - The corpus
 * @param git - The cell's git, in the corpus
 */
function addSubmodule(corpus: string, git: Git): void {
  const origin = safePath.join(corpus, '..', ORIGIN);
  if (!existsSync(origin)) {
    mkdirSyncReal(origin, { recursive: true });
    writeFileSync(safePath.join(origin, 'README.md'), '# Vendored\n\nA page in a submodule.\n');
    git(['-C', origin, 'init', '-q', '-b', 'main']);
    git(['-C', origin, 'add', '-A']);
    git(['-C', origin, 'commit', '-q', '-m', 'submodule']);
  }
  // Relative to the corpus, which has no remote of its own.
  git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', `../${ORIGIN}`, SUBMODULE]);
  git(['commit', '-q', '-m', 'add a submodule']);
  expect(git(['ls-files', '--stage', '--', SUBMODULE]).startsWith('160000 '), `${SUBMODULE} is a gitlink`).toBe(true);
  // The gitlink is realized as a directory with the mtime `submodule add` gave it: pinned, so the
  // store-off cell and the warm cell, each made at its own moment, realize it alike.
  utimesSync(safePath.join(corpus, SUBMODULE), SUBMODULE_MTIME, SUBMODULE_MTIME);
}

/**
 * The known gap: a submodule's files are not members (Phase 2 scans them), so an edit inside it
 * changes nothing any arm sees. The superproject's tree records the submodule's commit, not its
 * working tree, so the tree key stays and the warm run is served; store-off, reading the disk,
 * sees no member there either, so the two agree. The warm run is a read-only store hit: it reads
 * the store, writes nothing and answers from it. The day the population scans submodules, the
 * consumed check reds and this seed becomes an edit seed.
 */
const submoduleEdit: I0Seed = {
  name: 'submodule edit',
  needs: null,
  arms: EDIT_ARMS,
  verbs: ['query'],
  stateA: (corpus, git) => {
    addSubmodule(corpus, git);
    return Promise.resolve();
  },
  toB: (_arm, _dirs, corpus, git) => {
    appendEdit(corpus, SUBMODULE_FILE);
    expect(git(['status', '--porcelain', '--', SUBMODULE]).trim(), `git sees ${SUBMODULE} modified`).toBe(`M ${SUBMODULE}`);
    return Promise.resolve();
  },
  expect: { agrees: { because: 'a submodule\'s files are no members of the population until Phase 2 scans them', storeDeclines: null } },
  consumed: {
    runs: ['warmSameHistory:prime', 'warmSameHistory:measured', 'storeOff:measured'],
    check: (runs) => {
      expect(keysOf(runs, 'warmSameHistory:prime', SUBMODULE_FILE), `${SUBMODULE_FILE}: no member of the prime`).toEqual([]);
      expect(keysOf(runs, 'storeOff:measured', SUBMODULE_FILE), `${SUBMODULE_FILE}: no member after the edit`).toEqual([]);
      expect(keysOf(runs, 'storeOff:measured', SUBMODULE), `${SUBMODULE}: realized as the gitlink's directory, unkeyed`).toEqual([null]);
      const warm = runs['warmSameHistory:measured']?.query;
      if (warm === undefined) throw new Error('no warm measured query');
      expect(warm.charged, 'the warm run read the store').toContain(CRAWL_STORE_READ_ID);
      expect(warm.charged, 'the warm run wrote nothing: a hit derives nothing').not.toContain(CRAWL_STORE_WRITE_ID);
      expect(new Set(Object.values(warm.origins)), 'the warm run answered from the store').toEqual(new Set(['store']));
    },
  },
};

describe('warm edit: keys the store does not hold', () => {
  for (const seed of editSeedCases([evictedKey, symlinkRetarget, loadRefused, submoduleEdit], import.meta.url)) {
    it.skipIf(seed.unplantable)(seed.title, seed.run);
  }
});

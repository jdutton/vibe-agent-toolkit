/**
 * Warm edit seeds, tracked files: a warm run after an edit to tracked files extracts only the
 * edited keys and serves every other from the stored blob tier (the harness's `editServed` tell).
 *
 * - a one-file edit;
 * - a revert inside a new tree: one file edited and run over, then restored to its primed bytes
 *   while another is edited. The tree is new, so the extent misses; the restored file's key is the
 *   primed one, still held, so only the other file is extracted. A plain revert would return to the
 *   primed tree, a whole-extent hit that never reaches the blob tier;
 * - fifty files edited at once, over sixty bulk files the seed commits before the prime;
 * - `chmod +x`: the mode moves the tree, the bytes and so every key stay.
 *
 * Every edit is left uncommitted: `HEAD` never moves.
 */

import { chmodSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { corpusBytes, primedUncovered } from '../helpers/cache-differential.js';
import { appendEdit, contentKeyAt, contentKeysAt, editSeed, editSeedCases, keysMoved, keysOf, primeAndReference } from '../helpers/warm-edit-seeds.js';
import { writeFileTree } from '../system/test-common.js';

/** How many bulk markdown files the fifty-file seed commits beside the gate fixture's. */
const BULK_FILES = 60;

/** How many of them the fifty-file seed edits. */
const EDITED_FILES = 50;

/** A bulk file's path. */
function bulkPath(index: number): string {
  return `docs/bulk/${String(index).padStart(2, '0')}.md`;
}

/** The bulk files, each with bytes of its own. */
const BULK: Readonly<Record<string, string>> = Object.fromEntries(
  Array.from({ length: BULK_FILES }, (_, index) => [bulkPath(index), `# Bulk ${String(index)}\n\nBody of bulk file ${String(index)}.\n`]),
);

const ONE_FILE = 'docs/two.md';

const trackedEdit = editSeed({
  name: 'tracked edit',
  toB: (_arm, _dirs, corpus) => {
    appendEdit(corpus, ONE_FILE);
    return Promise.resolve();
  },
  uncovered: (_dirs, corpus) => [contentKeyAt(corpus, ONE_FILE)],
  consumed: keysMoved([ONE_FILE]),
});

/** The file edited and run over, then restored; and the file edited in the measured step. */
const RESTORED = 'docs/one.md';
const REVERT_EDITED = 'docs/guide.md';

/** Each cell's primed bytes of the restored file, taken before the intermediate edit. */
const primedBytes = new Map<string, Buffer>();

/** Each cell's key of the restored file's edited bytes, the ones the intermediate run read. */
const intermediateKeys = new Map<string, string>();

const revertInsideNewTree = editSeed({
  name: 'revert inside a new tree',
  intermediate: (_arm, dirs, corpus) => {
    primedBytes.set(dirs.root, corpusBytes(corpus, RESTORED));
    appendEdit(corpus, RESTORED);
    intermediateKeys.set(dirs.root, contentKeyAt(corpus, RESTORED));
    return Promise.resolve();
  },
  toB: (_arm, dirs, corpus) => {
    const bytes = primedBytes.get(dirs.root);
    if (bytes === undefined) throw new Error(`${RESTORED}: the intermediate step recorded no primed bytes`);
    writeFileSync(safePath.join(corpus, RESTORED), bytes);
    appendEdit(corpus, REVERT_EDITED);
    return Promise.resolve();
  },
  // The intermediate run filed the edited bytes' key: the store holds both of the file's keys, so
  // restoring it extracts nothing, and the edited key is in the store, not in the new tree.
  beforeRun: async (arm, dirs) => {
    if (arm !== 'warmSameHistory') return;
    const edited = intermediateKeys.get(dirs.root);
    if (edited === undefined) throw new Error(`${RESTORED}: the intermediate step recorded no edited key`);
    expect(await primedUncovered(dirs, [edited]), `${RESTORED}: the store covers the intermediate run's edited bytes`).toEqual([]);
  },
  uncovered: (_dirs, corpus) => [contentKeyAt(corpus, REVERT_EDITED)],
  consumed: {
    runs: ['warmSameHistory:prime', 'warmSameHistory:intermediate', 'storeOff:measured'],
    check: (runs) => {
      const primed = keysOf(runs, 'warmSameHistory:prime', RESTORED);
      expect(primed, `${RESTORED}: one primed key`).toHaveLength(1);
      // The intermediate run happened, over the edit: it keyed the restored file afresh.
      const intermediate = keysOf(runs, 'warmSameHistory:intermediate', RESTORED);
      expect(intermediate, `${RESTORED}: one intermediate key`).toHaveLength(1);
      expect(intermediate, `${RESTORED}: the intermediate run keyed the edit`).not.toEqual(primed);
      // Then it was restored: the measured tree keys it as the prime did.
      expect(keysOf(runs, 'storeOff:measured', RESTORED), `${RESTORED}: restored to its primed bytes`).toEqual(primed);
      expect(keysOf(runs, 'storeOff:measured', REVERT_EDITED), `${REVERT_EDITED}: edited`).not.toEqual(keysOf(runs, 'warmSameHistory:prime', REVERT_EDITED));
    },
  },
});

const FIFTY = Array.from({ length: EDITED_FILES }, (_, index) => bulkPath(index));

const fiftyFiles = editSeed({
  name: `${String(EDITED_FILES)} files`,
  stateA: (corpus, git) => {
    writeFileTree(corpus, BULK);
    git(['add', '--', 'docs/bulk']);
    git(['commit', '-q', '-m', 'bulk files']);
    return Promise.resolve();
  },
  toB: (_arm, _dirs, corpus) => {
    for (const path of FIFTY) appendEdit(corpus, path);
    return Promise.resolve();
  },
  uncovered: (_dirs, corpus) => contentKeysAt(corpus, FIFTY),
  consumed: keysMoved(FIFTY),
});

const EXECUTABLE = 'docs/two.md';

const chmodExecutable = editSeed({
  name: 'chmod +x',
  toB: (_arm, _dirs, corpus, git) => {
    // The index carries the mode on every host (a Windows checkout runs `core.filemode=false`), the disk where it can.
    chmodSync(safePath.join(corpus, EXECUTABLE), 0o755);
    git(['update-index', '--chmod=+x', '--', EXECUTABLE]);
    expect(git(['ls-files', '--stage', '--', EXECUTABLE]).startsWith('100755 '), `${EXECUTABLE} is executable in the index`).toBe(true);
    return Promise.resolve();
  },
  // The bytes are unchanged, so every key is the primed one.
  uncovered: () => [],
  consumed: primeAndReference((keysAt) => {
    expect(keysAt('storeOff:measured', EXECUTABLE), `${EXECUTABLE}: a mode is no part of a content key`).toEqual(keysAt('warmSameHistory:prime', EXECUTABLE));
  }),
});

describe('warm edit: tracked files', () => {
  for (const seed of editSeedCases([trackedEdit, revertInsideNewTree, fiftyFiles, chmodExecutable], import.meta.url)) {
    it.skipIf(seed.unplantable)(seed.title, seed.run);
  }
});

/**
 * Warm edit seeds, membership: a warm run after a file joins, leaves or moves in the tree
 * extracts only the keys the primed store lacks and serves every other from the stored blob tier
 * (the harness's `editServed` tell).
 *
 * - an untracked file added: its key is new;
 * - a tracked file deleted, renamed or copied: content keys are path-independent, so no key is
 *   new, and the miss extracts nothing.
 *
 * Every change is made on disk only: `HEAD` never moves.
 */

import { renameSync, rmSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { corpusBytes } from '../helpers/cache-differential.js';
import { contentKeyAt, editSeed, editSeedCases, primeAndReference } from '../helpers/warm-edit-seeds.js';

/** The tracked file each removal or move starts from. */
const MOVED = 'docs/two.md';

const ADDED = 'docs/added.md';

const untrackedAdd = editSeed({
  name: 'untracked add',
  toB: (_arm, _dirs, corpus) => {
    writeFileSync(safePath.join(corpus, ADDED), '# Added\n\nWritten after the prime, never committed.\n');
    return Promise.resolve();
  },
  uncovered: (_dirs, corpus) => [contentKeyAt(corpus, ADDED)],
  consumed: primeAndReference((keysAt) => {
    expect(keysAt('warmSameHistory:prime', ADDED), `${ADDED}: absent from the prime`).toEqual([]);
    expect(keysAt('storeOff:measured', ADDED), `${ADDED}: a member of the measured tree`).toHaveLength(1);
  }),
});

const deleted = editSeed({
  name: 'delete',
  toB: (_arm, _dirs, corpus) => {
    rmSync(safePath.join(corpus, MOVED));
    return Promise.resolve();
  },
  uncovered: () => [],
  consumed: primeAndReference((keysAt) => {
    expect(keysAt('warmSameHistory:prime', MOVED), `${MOVED}: a member of the prime`).toHaveLength(1);
    expect(keysAt('storeOff:measured', MOVED), `${MOVED}: deleted`).toEqual([]);
  }),
});

const RENAMED = 'docs/second.md';

const renamed = editSeed({
  name: 'rename',
  toB: (_arm, _dirs, corpus) => {
    renameSync(safePath.join(corpus, MOVED), safePath.join(corpus, RENAMED));
    return Promise.resolve();
  },
  uncovered: () => [],
  consumed: primeAndReference((keysAt) => {
    expect(keysAt('storeOff:measured', MOVED), `${MOVED}: renamed away`).toEqual([]);
    expect(keysAt('storeOff:measured', RENAMED), `${RENAMED}: the primed bytes under a new path`).toEqual(keysAt('warmSameHistory:prime', MOVED));
  }),
});

const COPY = 'docs/two-copy.md';

const copied = editSeed({
  name: 'copy',
  toB: (_arm, _dirs, corpus) => {
    // Written from the bytes read, never by spawning a copy command.
    writeFileSync(safePath.join(corpus, COPY), corpusBytes(corpus, MOVED));
    return Promise.resolve();
  },
  uncovered: () => [],
  consumed: primeAndReference((keysAt) => {
    expect(keysAt('storeOff:measured', MOVED), `${MOVED}: still there`).toEqual(keysAt('warmSameHistory:prime', MOVED));
    expect(keysAt('storeOff:measured', COPY), `${COPY}: the original's key`).toEqual(keysAt('warmSameHistory:prime', MOVED));
  }),
});

describe('warm edit: membership', () => {
  for (const seed of editSeedCases([untrackedAdd, deleted, renamed, copied], import.meta.url)) it.skipIf(seed.unplantable)(seed.title, seed.run);
});

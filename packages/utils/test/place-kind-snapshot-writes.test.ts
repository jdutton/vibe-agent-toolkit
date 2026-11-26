/**
 * A run that declares it writes nothing under its tree opens the place-kind snapshot, and every
 * shared write primitive refuses a write beneath that snapshot's roots
 * (`WRITE_UNDER_PLACE_KIND_SNAPSHOT`, a defect: the run is mis-declared and would read stale
 * kinds). A write outside the roots (VAT's cache, the temp directory) and any write inside
 * `withoutPlaceKindSnapshot` (a run that declares its writes) go ahead.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { beforeEach, describe, expect, it } from 'vitest';

import { zipOfEntries } from '../src/archive/zip-reader.js';
import { extractArchive } from '../src/archive.js';
import { isVatError } from '../src/errors/vat-error.js';
import { WRITE_UNDER_PLACE_KIND_SNAPSHOT_CODE } from '../src/index.js';
import { withoutPlaceKindSnapshot, withPlaceKindSnapshot } from '../src/link-following.js';
import { safePath } from '../src/path-core.js';
import { mkdirSyncReal } from '../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../src/test-helpers.js';
import { applyTreePlan } from '../src/tree-change/apply.js';
import { copyRegularFile, copyTree } from '../src/tree-change/copy-tree.js';
import { makeDirectoryUnder, openFileUnder, removeEntry, renameFileAtomic, replaceFile, writeFileUnder } from '../src/tree-change/files.js';
import { planTreeChanges } from '../src/tree-change/plan.js';

import { useCanonicalTempRoot } from './test-helpers.js';

/** Every shared write primitive, each aimed at `tree` (with `source` a readable tree beside it). */
function writesInto(tree: string, source: string): ReadonlyMap<string, () => unknown> {
  const file = safePath.join(source, 'f.md');
  return new Map<string, () => unknown>([
    ['writeFileUnder', () => writeFileUnder(tree, 'new.md', 'x', { existing: 'refuse', writing: 'a file' })],
    ['openFileUnder', () => openFileUnder(tree, 'opened.md', { existing: 'refuse', writing: 'a file' }).then((handle) => handle.close())],
    ['makeDirectoryUnder', () => makeDirectoryUnder(tree, 'made', 'a directory')],
    ['replaceFile', () => replaceFile(safePath.join(tree, 'kept.md'), 'y')],
    ['removeEntry', () => removeEntry(safePath.join(tree, 'kept.md'))],
    ['renameFileAtomic (to)', () => renameFileAtomic(file, safePath.join(tree, 'moved.md'))],
    ['renameFileAtomic (from)', () => renameFileAtomic(safePath.join(tree, 'kept.md'), safePath.join(source, 'moved.md'))],
    ['copyTree', () => copyTree(source, tree, 'copied', { links: 'preserve', side: 'source', onto: 'fresh' })],
    ['copyRegularFile', () => copyRegularFile(file, tree, 'copied.md', { side: 'source', reading: 'f.md', existing: 'refuse', writing: 'a copy' })],
    ['extractArchive', () => extractArchive({ bytes: zipOfEntries([{ place: 'z.md', data: Buffer.from('z'), executable: false }]), label: 'fixture' }, safePath.join(tree, 'extracted'), { format: 'zip', limits: { maxEntries: 10, maxBytes: 1000 } })],
    ['applyTreePlan', async () => applyTreePlan(await planTreeChanges([{ op: 'replace', dest: safePath.join(tree, 'planned'), ownership: { kind: 'vat-state' }, fill: { from: 'write', write: async (staged: string) => { writeFileSync(safePath.join(staged, 'p.md'), 'p'); } }, label: 'planned' }]))],
    ['mkdirSyncReal', () => mkdirSyncReal(safePath.join(tree, 'real'))],
  ]);
}

/** What `write` threw (or rejected with), `undefined` when it finished. */
async function failureOf(write: () => unknown): Promise<unknown> {
  try {
    await write();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

describe('a write under an open place-kind snapshot', () => {
  const tempRoot = useCanonicalTempRoot('place-kind-writes');
  let tree: string;
  let source: string;

  beforeEach(() => {
    const base = tempRoot();
    tree = safePath.join(base, 'tree');
    source = safePath.join(base, 'source');
    mkdirSyncReal(tree);
    mkdirSyncReal(source);
    writeFileSync(safePath.join(tree, 'kept.md'), 'kept');
    writeFileSync(safePath.join(source, 'f.md'), 'f');
  });

  it.each([...writesInto('', '').keys()])('is refused by %s, nothing written', async (name) => {
    const write = writesInto(tree, source).get(name) ?? (() => undefined);
    const error = await withPlaceKindSnapshot(tree, () => failureOf(write));
    expect(isVatError(error, WRITE_UNDER_PLACE_KIND_SNAPSHOT_CODE), String(error)).toBe(true);
    expect(readFileSync(safePath.join(tree, 'kept.md'), 'utf8')).toBe('kept');
  });

  it('is refused when the write names the tree through a link to it (the snapshot keeps both spellings)', async ({ skip }) => {
    // Skipped where this host cannot create a symlink (Windows without Developer Mode or the privilege).
    const cap = symlinkCapability() ?? skip();
    const alias = safePath.join(source, 'alias');
    createSymlink(cap, tree, alias, 'dir');
    const error = await withPlaceKindSnapshot(alias, () => failureOf(() => writeFileUnder(tree, 'new.md', 'x', { existing: 'refuse', writing: 'a file' })));
    expect(isVatError(error, WRITE_UNDER_PLACE_KIND_SNAPSHOT_CODE)).toBe(true);
  });

  it('goes ahead outside the snapshot\'s roots (VAT\'s cache, the temp directory)', async () => {
    await withPlaceKindSnapshot(tree, () => writeFileUnder(source, 'cache.md', 'c', { existing: 'refuse', writing: 'a cache file' }));
    expect(readFileSync(safePath.join(source, 'cache.md'), 'utf8')).toBe('c');
  });

  it('goes ahead inside a run that declares its writes, whatever snapshot encloses it', async () => {
    await withPlaceKindSnapshot(tree, () => withoutPlaceKindSnapshot(() => writeFileUnder(tree, 'new.md', 'x', { existing: 'refuse', writing: 'a file' })));
    expect(readFileSync(safePath.join(tree, 'new.md'), 'utf8')).toBe('x');
  });
});

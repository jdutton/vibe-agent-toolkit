/**
 * `extractArchive` on a real filesystem, both formats: what a sound archive becomes on disk, and
 * that every hostile one ({@link hostileArchiveRows}) is refused with NOTHING written — the
 * directory it was aimed at, and everything around that directory, as they were.
 */
import { lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extractArchive, listArchive } from '../../src/archive/archive.js';
import { ARCHIVE_REFUSED_CODE, type ArchiveFormat, type ArchiveLimits } from '../../src/archive/entries.js';
import { zipOfDirectory } from '../../src/archive/zip-reader.js';
import { isFsFaultError } from '../../src/errors/fs-fault.js';
import { isVatError } from '../../src/errors/vat-error.js';
import { safePath } from '../../src/path-core.js';
import { mkdirSyncReal } from '../../src/path-utils.js';
import { type ArchiveFixtureEntry, hostileArchive, hostileArchiveRows, tarFixture, zipFixture } from '../../src/testing/archive-fixtures.js';
import { PERMISSIONS_ENFORCED } from '../../src/testing/platform-gates.js';
import { diffSnapshots, snapshotTree } from '../../src/testing/tree-snapshot.js';

import { plant, rejectionOf, treeChangeSuite } from './tree-change-test-kit.js';

const suite = treeChangeSuite('archive-extract-');

/** Small enough that the two limit rows are a handful of entries, not fifty thousand. */
const LIMITS: ArchiveLimits = { maxEntries: 12, maxBytes: 4096 };

const BUILD: Readonly<Record<ArchiveFormat, (entries: readonly ArchiveFixtureEntry[]) => Buffer>> = {
  tar: (entries) => tarFixture(entries),
  zip: (entries) => zipFixture(entries),
};

const SOUND: readonly ArchiveFixtureEntry[] = [
  { name: 'skill/', kind: 'directory' },
  { name: 'skill/SKILL.md', data: '# skill\n' },
  { name: 'skill/references/notes.md', data: 'notes\n' },
];

/** A scratch root holding the empty directory an extraction is aimed at, and a neighbour that must never change. */
function stage(): { root: string; into: string } {
  const root = suite.root();
  const into = safePath.join(root, 'staging', 'into');
  mkdirSyncReal(into, { recursive: true });
  writeFileSync(safePath.join(root, 'neighbour.txt'), 'untouched');
  return { root, into };
}

describe.each(['tar', 'zip'] as const)('extractArchive (%s)', (format) => {
  const extract = (entries: readonly ArchiveFixtureEntry[], into: string, limits = LIMITS): ReturnType<typeof extractArchive> =>
    extractArchive({ bytes: BUILD[format](entries), label: `fixture.${format}` }, into, { format, limits });

  it('writes every file and directory of a sound archive, and returns what it wrote', async () => {
    const { into } = stage();

    const written = await extract(SOUND, into);

    expect(written.map((entry) => entry.name)).toEqual(SOUND.map((entry) => entry.name));
    expect(readFileSync(safePath.join(into, 'skill', 'SKILL.md'), 'utf8')).toBe('# skill\n');
    expect(readFileSync(safePath.join(into, 'skill', 'references', 'notes.md'), 'utf8')).toBe('notes\n');
  });

  it('makes the directories an archive implies but does not list', async () => {
    const { into } = stage();
    await extract([{ name: 'a/b/c.md', data: 'deep' }], into);
    expect(readFileSync(safePath.join(into, 'a', 'b', 'c.md'), 'utf8')).toBe('deep');
  });

  it('reads a backslash in a name as a separator on every host', async () => {
    const { into } = stage();
    await extract([{ name: String.raw`skill\SKILL.md`, data: 'x' }], into);
    expect(readdirSync(into)).toEqual(['skill']);
    expect(readdirSync(safePath.join(into, 'skill'))).toEqual(['SKILL.md']);
  });

  it.skipIf(!PERMISSIONS_ENFORCED)('keeps only the executable bit of an entry\'s mode: 0755 or 0644, never setuid, setgid or sticky', async () => {
    const { into } = stage();
    await extract([
      { name: 'run.sh', data: '#!/bin/sh\n', mode: 0o4755 },
      { name: 'tool', data: 'x', mode: 0o2711 },
      { name: 'secret.md', data: 'x', mode: 0o1600 },
      { name: 'open.md', data: 'x', mode: 0o666 },
    ], into);

    const modeOf = (name: string): number => statSync(safePath.join(into, name)).mode & 0o7777;
    expect({ run: modeOf('run.sh'), tool: modeOf('tool'), secret: modeOf('secret.md'), open: modeOf('open.md') })
      .toEqual({ run: 0o755, tool: 0o755, secret: 0o644, open: 0o644 });
  });

  it.each(hostileArchiveRows(LIMITS).filter((row) => row.formats.includes(format)))('refuses an archive holding $what, with nothing written', async (row) => {
    const { root, into } = stage();
    const before = snapshotTree(root);

    const bytes = hostileArchive(row, BUILD[format]([...SOUND, ...row.entries('skill/')]));

    const error = await rejectionOf(() => extractArchive({ bytes, label: `fixture.${format}` }, into, { format, limits: LIMITS }));

    expect(isVatError(error, ARCHIVE_REFUSED_CODE), String(error)).toBe(true);
    expect(error).toMatchObject({ reason: row.reason });
    // Nothing: not the sound entries listed before the offending one, and nothing outside `into`.
    expect(readdirSync(into)).toEqual([]);
    expect(diffSnapshots(before, snapshotTree(root))).toEqual([]);
  });

  it('leaves an omitted entry unwritten, and still judges it', async () => {
    const { into } = stage();
    const litter = (entry: { readonly name: string }): boolean => entry.name.startsWith('litter/');
    const source = (entries: readonly ArchiveFixtureEntry[]): { bytes: Buffer; label: string } => ({ bytes: BUILD[format](entries), label: `fixture.${format}` });

    const listed = await extractArchive(source([...SOUND, { name: 'litter/x.bin', data: 'x' }]), into, { format, limits: LIMITS, omit: litter });

    expect(listed.map((entry) => entry.name)).toContain('litter/x.bin');
    expect(readdirSync(into)).toEqual(['skill']);
    // Omitted from the write, never from the policy: a link there refuses the archive whole.
    const second = stage().into;
    const error = await rejectionOf(() => extractArchive(source([...SOUND, { name: 'litter/out', kind: 'link', target: '..' }]), second, { format, limits: LIMITS, omit: litter }));
    expect(error).toMatchObject({ reason: 'link' });
    expect(readdirSync(second)).toEqual([]);
  });

  it('never writes a link, even one whose target is inside the archive', async () => {
    const { into } = stage();
    await rejectionOf(() => extract([{ name: 'a.md', data: 'x' }, { name: 'b.md', kind: 'link', target: 'a.md' }], into));
    expect(readdirSync(into)).toEqual([]);
  });

  it('classifies a write the OS refuses as the staging\'s fault, not the archive\'s', async () => {
    const { into } = stage();
    suite.faults(into, [{ family: 'write', op: 'open', path: (path) => path.endsWith('SKILL.md'), errno: 'ENOSPC' }]);

    const error = await rejectionOf(() => extract(SOUND, into));
    suite.restoreFaults();

    expect(isFsFaultError(error), String(error)).toBe(true);
    expect(error).toMatchObject({ side: 'environment', faultClass: 'exhausted' });
  });
});

describe('extractArchive from a file', () => {
  it('extracts an archive the caller names by path', async () => {
    const { root, into } = stage();
    const file = safePath.join(root, 'skill.zip');
    writeFileSync(file, zipFixture(SOUND));

    await extractArchive({ file, side: 'source' }, into, { format: 'zip', limits: LIMITS });

    expect(lstatSync(safePath.join(into, 'skill', 'SKILL.md')).isFile()).toBe(true);
  });

  it.each(['source', 'environment'] as const)('classifies an archive it cannot read on the side the caller declared (%s)', async (side) => {
    const { root, into } = stage();

    const error = await rejectionOf(() => extractArchive({ file: safePath.join(root, 'absent.tgz'), side }, into, { format: 'tar', limits: LIMITS }));

    expect(isFsFaultError(error), String(error)).toBe(true);
    expect(error).toMatchObject({ side, faultClass: 'absent' });
  });

  it('refuses a file larger than any archive within the limits can be, unread', async () => {
    const { root, into } = stage();
    const file = safePath.join(root, 'huge.tgz');
    writeFileSync(file, Buffer.alloc(2 * 1024 * 1024));

    const error = await rejectionOf(() => extractArchive({ file, side: 'source' }, into, { format: 'tar', limits: { maxEntries: 1, maxBytes: 1 } }));

    expect(error).toMatchObject({ code: ARCHIVE_REFUSED_CODE, reason: 'too-large' });
  });

  it('names the archive by the path the caller gave in a refusal', async () => {
    const { root, into } = stage();
    const file = safePath.join(root, 'evil.tgz');
    writeFileSync(file, tarFixture([{ name: 'keys', kind: 'link', target: '/etc' }]));

    const error = await rejectionOf(() => extractArchive({ file, side: 'source' }, into, { format: 'tar', limits: LIMITS }));

    expect((error as Error).message).toContain(`${file} is not an archive VAT accepts, nothing was changed`);
  });
});

describe('zipOfDirectory', () => {
  it('archives every file of a tree under its name relative to the tree, as an archive extractArchive takes back', async () => {
    const root = suite.root();
    const tree = safePath.join(root, 'bundle');
    plant(tree, { 'SKILL.md': '# skill\n', 'references/notes.md': 'notes\n' });

    const bytes = zipOfDirectory(tree);

    const listed = await listArchive({ bytes, label: 'bundle.zip' }, { format: 'zip', limits: LIMITS });
    expect(new Set(listed.filter((entry) => entry.kind === 'file').map((entry) => entry.name))).toEqual(new Set(['SKILL.md', 'references/notes.md']));
    const into = safePath.join(root, 'back');
    mkdirSyncReal(into);
    await extractArchive({ bytes, label: 'bundle.zip' }, into, { format: 'zip', limits: LIMITS });
    expect(readFileSync(safePath.join(into, 'references', 'notes.md'), 'utf8')).toBe('notes\n');
  });

  // The ZIP library reads the tree through `fs` looked up at call time, which is what lets a fault
  // injected under the tree reach it: pinned, because the packager's fault-matrix cases rely on it.
  it('raises the raw errno of a read the OS refuses, for the caller to classify', () => {
    const tree = safePath.join(suite.root(), 'bundle');
    plant(tree, { 'SKILL.md': '# skill\n' });
    const session = suite.faults(tree, [{ family: 'read', path: (path) => path.endsWith('SKILL.md'), errno: 'EACCES' }]);

    expect(() => zipOfDirectory(tree)).toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect(session.fired.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * The reproduction behind this module (`tarchain`): a chain of links whose every target is
 * textually inside the archive, and which really climbs one directory per link. An extractor
 * that judges a link by its text creates all of them; this one creates none.
 */
describe('a chain of links that climbs out of the extraction directory', () => {
  it('is refused at its first link, and no file outside the archive is reachable through what was extracted', async () => {
    const { root, into } = stage();
    writeFileSync(safePath.join(root, 'PRIVATE.txt'), 'outside the archive');
    const chain = tarFixture([
      { name: 'pkg/sub/', kind: 'directory' },
      { name: 'pkg/sub/d', kind: 'link', target: '..' },
      { name: 'pkg/sub/e', kind: 'link', target: 'd/..' },
      { name: 'pkg/sub/f', kind: 'link', target: 'e/..' },
      { name: 'pkg/sub/g', kind: 'link', target: 'f/..' },
      { name: 'pkg/file', data: 'x' },
    ]);

    const error = await rejectionOf(() => extractArchive({ bytes: chain, label: 'chain.tgz' }, into, { format: 'tar', limits: LIMITS }));

    expect(error).toMatchObject({ code: ARCHIVE_REFUSED_CODE, reason: 'link', entry: 'pkg/sub/d' });
    expect(readdirSync(into)).toEqual([]);
  });
});

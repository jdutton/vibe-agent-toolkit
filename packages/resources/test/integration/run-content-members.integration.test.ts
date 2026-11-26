/**
 * A run's content cache over a tree key's members: a member is keyed by its git object name with
 * no read and no hash, read from git's object store only when its bytes are asked for, refused by
 * its object's size, and a missing object refuses only its own path. A run with no members reads
 * disk exactly as before. `readContentByKey` reads a key's bytes from where the key says they are.
 */

import { chmodSync, rmSync, truncateSync, writeFileSync } from 'node:fs';

import { isVatError, readWorkCounters, safePath } from '@vibe-agent-toolkit/utils';
import {
  GitObjectMissingError,
  GitObjectReadError,
  type GitMembers,
  gitMembersOf,
  type GitObjectReaders,
  gitSnapshotFailureOf,
  gitTreeKey,
  openGitObjectReaders,
} from '@vibe-agent-toolkit/utils/git';
import { __resetWorkCountersForTest, createTempDir, plantFiles, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeContentKey, formatContentKey, readContentByKey } from '../../src/content-key.js';
import { NO_GIT_MEMBERS, POPULATION_PARSE_LIMITS, RunContentCache, type RunMembersSource } from '../../src/projection/content-cache.js';
import { collectRealization } from '../../src/projection/realizations.js';
import { type PopulationRun, withPopulationRun } from '../../src/projection/run-population.js';
import { git } from '../helpers/git-fixture.js';

const DOC = 'doc.md';
const LF_TEXT = 'line one\nline two\n';
const CRLF_TEXT = 'line one\r\nline two\r\n';

let dir: string;
let objects: GitObjectReaders;

/** The tree's members, or a failed test naming why git declined the key. */
function membersOf(root: string, readers: GitObjectReaders): GitMembers {
  const key = gitTreeKey({ cwd: root });
  if (!key.ok) throw new Error(`declined: ${gitSnapshotFailureOf(key).reason}`);
  const members = gitMembersOf(key, readers);
  if (members === null) throw new Error('no members');
  return members;
}

/** The fixture tree's members, over the test's readers, resolved at the cache's first ask. */
function treeMembers(): RunMembersSource {
  return { root: dir, resolve: () => membersOf(dir, objects) };
}

/** A committed repository holding `files`. */
function committed(files: Record<string, string>): void {
  git(dir, 'init', '-q');
  plantFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
}

/** The checkout an autocrlf=true Windows clone has of {@link DOC}: CRLF on disk, LF in git. */
function autocrlfCheckout(): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'core.autocrlf', 'true');
  plantFiles(dir, { [DOC]: LF_TEXT });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  writeFileSync(safePath.join(dir, DOC), CRLF_TEXT);
}

/** The object name git gives `relative`'s file now. */
function oidOf(relative: string): string {
  return git(dir, 'hash-object', relative);
}

/** The counters that say whether a path was read and hashed from disk, or read from git. */
function readCounts(): { read: number; hashed: number; gitRead: number; refused: number } {
  const counts = readWorkCounters();
  return {
    read: counts['content.read'],
    hashed: counts['content.hashed'],
    gitRead: counts['content.gitRead'],
    refused: counts['parse.refused.inputCap.read'],
  };
}

beforeEach(() => {
  dir = createTempDir('vat-run-content-members-');
  objects = openGitObjectReaders({});
  __resetWorkCountersForTest();
});

afterEach(async () => {
  await objects.close();
  removeTempDir(dir);
});

describe('RunContentCache over members', () => {
  it('keys a member by its object name with no disk read and no hash', async () => {
    committed({ [DOC]: LF_TEXT });
    const cache = new RunContentCache(treeMembers());

    const key = await cache.key(safePath.join(dir, DOC), 'markdown');

    expect(key).toBe(formatContentKey({ parserKind: 'markdown', keyKind: 'git-sha1', hex: oidOf(DOC) }));
    expect(readCounts()).toStrictEqual({ read: 0, hashed: 0, gitRead: 0, refused: 0 });
  });

  it('reads a member\'s bytes from git under the member key, not the working tree\'s', async () => {
    autocrlfCheckout();
    const cache = new RunContentCache(treeMembers());
    const path = safePath.join(dir, DOC);

    const key = await cache.key(path, 'markdown');
    const keyed = await cache.read(path, 'markdown');

    expect(keyed.key).toBe(key);
    expect(keyed.content).toBe(LF_TEXT);
    expect(keyed.byteLength).toBe(LF_TEXT.length);
    expect(await cache.read(path, 'markdown')).toBe(keyed);
    expect(readCounts()).toStrictEqual({ read: 0, hashed: 0, gitRead: 1, refused: 0 });
  });

  it('refuses an oversize member by its object\'s size, reading no object, counted once', async () => {
    git(dir, 'init', '-q');
    const big = safePath.join(dir, 'big.md');
    writeFileSync(big, '');
    truncateSync(big, POPULATION_PARSE_LIMITS.inputBytes + 1);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
    const cache = new RunContentCache(treeMembers());

    await expect(cache.key(big, 'markdown')).rejects.toMatchObject({ limit: 'inputBytes' });
    await expect(cache.read(big, 'markdown')).rejects.toMatchObject({ limit: 'inputBytes' });
    await expect(cache.key(big, 'markdown')).rejects.toMatchObject({ limit: 'inputBytes' });

    expect(readCounts()).toStrictEqual({ read: 0, hashed: 0, gitRead: 0, refused: 1 });
    // A kind no parser reads is never held to the cap: its key is the object name.
    await expect(cache.key(big, 'none')).resolves.toBe(`none.git-sha1.${oidOf('big.md')}`);
  });

  it('makes a missing object that one path\'s unreadable realization, and the run goes on', async () => {
    committed({ 'kept.md': '# kept\n' });
    plantFiles(dir, { 'gone.md': '# never committed\n' });
    const members = membersOf(dir, objects);
    const gone = oidOf('gone.md');
    // The snapshot wrote the blob loose; pruning it is what a `git gc` would do.
    rmSync(safePath.join(dir, '.git', 'objects', gone.slice(0, 2), gone.slice(2)));
    const cache = new RunContentCache({ root: dir, resolve: () => members });
    const context = { root: dir, extentId: 'git', contentCache: cache };

    await expect(cache.key(safePath.join(dir, 'gone.md'), 'markdown')).rejects.toSatisfy((error) => isVatError(error, GitObjectMissingError.code));
    const goneRow = await collectRealization(safePath.join(dir, 'gone.md'), 'gone', context);
    const keptRow = await collectRealization(safePath.join(dir, 'kept.md'), 'kept', context);

    expect(goneRow).toMatchObject({ contentKey: null, contentState: 'unreadable' });
    expect(keptRow).toMatchObject({ contentKey: `markdown.git-sha1.${oidOf('kept.md')}`, contentState: 'keyed' });
  });

  // Root opens a 000 file anyway, and Windows has no mode bits to clear: neither can make one unreadable.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a member whose file cannot be opened now, as a disk read would, reading nothing', async () => {
    committed({ [DOC]: LF_TEXT });
    const path = safePath.join(dir, DOC);
    // The snapshot before the mode change: git's own `add` would open a file whose stat moved.
    const members = membersOf(dir, objects);
    chmodSync(path, 0o000);
    try {
      const cache = new RunContentCache({ root: dir, resolve: () => members });

      await expect(cache.key(path, 'markdown')).rejects.toMatchObject({ code: 'EACCES' });
      await expect(cache.read(path, 'markdown')).rejects.toMatchObject({ code: 'EACCES' });
      // One probe for both asks, and no byte read from disk or from git.
      expect(readWorkCounters()['fs.stat']).toBe(1);
      expect(readCounts()).toStrictEqual({ read: 0, hashed: 0, gitRead: 0, refused: 0 });
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it('reads and hashes from disk, exactly as before, with no members', async () => {
    committed({ [DOC]: LF_TEXT });
    const cache = new RunContentCache(NO_GIT_MEMBERS);

    const key = await cache.key(safePath.join(dir, DOC), 'markdown');

    expect(readCounts()).toStrictEqual({ read: 1, hashed: 1, gitRead: 0, refused: 0 });
    expect(cache.stats.misses).toBe(1);
    expect(key).toBe(computeContentKey(Buffer.from(LF_TEXT), 'markdown'));
  });

  it('fixes membership at the first ask: a file written after it keys from disk', async () => {
    committed({ [DOC]: LF_TEXT });
    const cache = new RunContentCache(treeMembers());

    await cache.key(safePath.join(dir, DOC), 'markdown');
    plantFiles(dir, { 'later.md': '# after the snapshot\n' });
    const key = await cache.key(safePath.join(dir, 'later.md'), 'markdown');

    expect(key).toBe(computeContentKey(Buffer.from('# after the snapshot\n'), 'markdown'));
  });
});

describe('readContentByKey', () => {
  it('reads a git key\'s object from the repository holding the path', async () => {
    autocrlfCheckout();
    const key = formatContentKey({ parserKind: 'markdown', keyKind: 'git-sha1', hex: oidOf(DOC) });

    const keyed = await readContentByKey(safePath.join(dir, DOC), key, objects);

    expect(keyed).toMatchObject({ key, content: LF_TEXT, parserKind: 'markdown', byteLength: LF_TEXT.length });
    expect(readCounts()).toMatchObject({ read: 0, hashed: 0, gitRead: 1 });
  });

  it('reads a sha256 key\'s file from disk and keys it again, so a changed file says so', async () => {
    plantFiles(dir, { [DOC]: LF_TEXT });
    const key = computeContentKey(Buffer.from(LF_TEXT), 'markdown');

    expect((await readContentByKey(safePath.join(dir, DOC), key, objects)).key).toBe(key);
    writeFileSync(safePath.join(dir, DOC), CRLF_TEXT);
    expect((await readContentByKey(safePath.join(dir, DOC), key, objects)).key).not.toBe(key);
  });
});

describe('withPopulationRun', () => {
  it('builds its members over its own readers, and closes them when the run ends', async () => {
    committed({ [DOC]: LF_TEXT });
    let held: PopulationRun | undefined;

    const content = await withPopulationRun({ root: dir, resolve: (readers) => membersOf(dir, readers) }, async (run) => {
      held = run;
      return (await run.content.read(safePath.join(dir, DOC), 'markdown')).content;
    });

    expect(content).toBe(LF_TEXT);
    expect(readCounts().gitRead).toBe(1);
    if (held === undefined) throw new Error('the run never ran');
    await expect(held.objects.read(dir, oidOf(DOC))).rejects.toSatisfy((error) => isVatError(error, GitObjectReadError.code));
  });
});

/**
 * A listing (a root with no store) and a stored population answer the same
 * conditions for the same tree: an unlistable directory, a declined link, a
 * gap in ignored territory or a submodule. The store-on arm runs inside a
 * snapshot bracket, as the CLI's does, so a tracker initialized in it reads the
 * snapshot instead of spawning `ls-files`.
 */

import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import type { DirectoryRefusal } from '@vibe-agent-toolkit/utils/crawl';
import { GIT_NO_ANSWER_CODE, GitTracker, gitTreeKey, gitTreeSnapshot, withGitSnapshotCache } from '@vibe-agent-toolkit/utils/git';
import { CANNOT_DENY_READS, createSymlink, plantFiles, symlinkCapability } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  emptyBlobRows,
  type BlobScopedRows,
  type ExtentScopedRows,
  type FactStore,
} from '../../src/index.js';
import { isDeclinedSymlinkCode } from '../../src/projection/contributors/filesystem-extent.js';
import { GitCrawlSource, type PopulationUnreadablePolicy } from '../../src/projection/crawl-source.js';
import type { PopulationCache } from '../../src/projection/merge.js';
import type { IgnoredRefusals } from '../../src/projection/resource-population.js';
import { withRunPopulation } from '../../src/projection/run-population.js';
import { ResourceRegistry } from '../../src/resource-registry.js';
import { git, nestedRepository } from '../helpers/git-fixture.js';

const roots: string[] = [];
const locked: string[] = [];
afterEach(() => {
  for (const path of locked.splice(0)) chmodSync(path, 0o755);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fresh repository with `files` written and committed. */
function repository(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-root-listing-parity-'));
  roots.push(root);
  plantFiles(root, files);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

/** Make `relative` under `root` a directory holding one document, mode 000. */
function lockedDirectory(root: string, relative: string): void {
  const directory = safePath.join(root, relative);
  mkdirSyncReal(directory, { recursive: true });
  writeFileSync(safePath.join(directory, 'hidden.md'), '# Hidden\n');
  chmodSync(directory, 0o000);
  locked.push(directory);
}

/** A store that holds nothing: every read misses, so the home is always derived. */
function emptyStore(): FactStore {
  return {
    writeBlobFacts: () => Promise.resolve(),
    readBlobFacts: (): Promise<BlobScopedRows> => Promise.resolve(emptyBlobRows()),
    writeExtent: () => Promise.resolve(),
    readExtent: (): Promise<ExtentScopedRows | undefined> => Promise.resolve(undefined),
    close: () => Promise.resolve(),
  };
}

interface Crawled {
  readonly members: string[];
  readonly declinedLinks: string[];
  readonly unlistable: string[];
  readonly degraded: string[];
  readonly refused: string | undefined;
}

/**
 * Crawl `baseDir` in a run homed at `home`: store on (a snapshot bracket, the
 * store keyed by its snapshot) or off.
 */
function crawl(options: {
  home: string;
  baseDir: string;
  store: boolean;
  include?: readonly string[];
  degrade?: boolean;
  /** `record` unless said: the lanes that report ignored-territory refusals are the ones parity binds. */
  ignoredRefusals?: IgnoredRefusals;
}): Promise<Crawled> {
  const { home, baseDir, store } = options;
  const degraded: string[] = [];
  const unreadable: PopulationUnreadablePolicy = options.degrade === true
    ? { degrade: (refusal: DirectoryRefusal) => { degraded.push(safePath.relative(baseDir, refusal.directory)); } }
    : 'refuse';
  const cacheOf = (): Promise<PopulationCache | undefined> => {
    if (!store) return Promise.resolve(undefined);
    const snapshot = gitTreeSnapshot({ cwd: home });
    if (!snapshot.ok) throw new Error('the fixture must snapshot');
    return Promise.resolve({ store: emptyStore(), treeHash: snapshot.hash, treeUnchanged: () => true });
  };
  const run = (): Promise<Crawled> => withRunPopulation(
    { root: home, outputs: [], gitTracker: new GitTracker(home), cacheOf, collectionsFor: () => Promise.resolve(undefined) },
    async (population) => {
      // The CLI opens the store before anything else asks git: the snapshot is then in hand.
      if (store) await cacheOf();
      const registry = ResourceRegistry.forRun(population, { baseDir }).view({ baseDir });
      try {
        await registry.crawl({
          baseDir,
          include: [...(options.include ?? ['**/*.md'])],
          outputs: [],
          unreadable,
          ignoredRefusals: options.ignoredRefusals ?? 'record',
          populationSource: population.source,
        });
      } catch (error) {
        return { members: [], declinedLinks: [], unlistable: [], degraded, refused: error instanceof Error ? error.message : String(error) };
      }
      const issues = (await registry.validate()).issues;
      return {
        members: registry.getAllResources().map((resource) => safePath.relative(baseDir, resource.filePath)).toSorted((a, b) => a.localeCompare(b)),
        declinedLinks: issues.filter((issue) => isDeclinedSymlinkCode(issue.code)).map((issue) => String(issue.location)).toSorted((a, b) => a.localeCompare(b)),
        unlistable: issues.filter((issue) => issue.code === 'EXTENT_DIRECTORY_UNLISTABLE').map((issue) => String(issue.location)).toSorted((a, b) => a.localeCompare(b)),
        degraded,
        refused: undefined,
      };
    },
  );
  return store ? withGitSnapshotCache(run) : run();
}

/** Both arms, store off first. */
async function bothArms(options: Omit<Parameters<typeof crawl>[0], 'store'>): Promise<{ off: Crawled; on: Crawled }> {
  return { off: await crawl({ ...options, store: false }), on: await crawl({ ...options, store: true }) };
}

describe.skipIf(CANNOT_DENY_READS)('an unlistable directory is the same gap with the store on or off', () => {
  it('a second root of the run refuses it either way', async () => {
    const home = repository({ 'projA/a.md': '# A\n', 'projB/b.md': '# B\n' });
    lockedDirectory(home, 'projB/locked');
    const { off, on } = await bothArms({ home: safePath.join(home, 'projA'), baseDir: safePath.join(home, 'projB') });
    expect(off.refused, 'store off refuses').toContain('locked');
    expect(on.refused, 'store on refuses the same directory').toContain('locked');
  });

  it('a degrading crawl of the home hands it over either way', async () => {
    const home = repository({ 'a.md': '# A\n' });
    lockedDirectory(home, 'locked');
    const { off, on } = await bothArms({ home, baseDir: home, degrade: true });
    expect(off.degraded).toEqual(['locked']);
    expect(on.degraded).toEqual(['locked']);
  });

  it('a subdirectory root records an unlistable directory inside its ignored territory', async () => {
    const home = repository({ 'pkg/doc.md': '# Doc\n', 'pkg/.gitignore': 'build/\n' });
    mkdirSyncReal(safePath.join(home, 'pkg', 'build'), { recursive: true });
    writeFileSync(safePath.join(home, 'pkg', 'build', 'out.txt'), 'out\n');
    lockedDirectory(home, 'pkg/build/cache');
    const pkg = safePath.join(home, 'pkg');
    const { off, on } = await bothArms({ home: pkg, baseDir: pkg });
    expect(on.unlistable, 'positive control: the stored population records it').toEqual(['build/cache']);
    expect(off.unlistable).toEqual(on.unlistable);
  });

  it('a listing never walks ignored territory for a crawl that drops its refusals', async () => {
    const home = repository({ 'doc.md': '# Doc\n', '.gitignore': 'build/\n' });
    mkdirSyncReal(safePath.join(home, 'build'), { recursive: true });
    lockedDirectory(home, 'build/cache');
    const recorded = await crawl({ home, baseDir: home, store: false });
    const skipped = await crawl({ home, baseDir: home, store: false, ignoredRefusals: 'skip' });
    expect(recorded.unlistable, 'positive control: a crawl that reports them walks to it').toEqual(['build/cache']);
    expect(skipped.unlistable).toEqual([]);
    expect(skipped.members).toEqual(recorded.members);
  });

  it('a nested repository refuses an unlistable directory inside it either way', async () => {
    const home = repository({ 'a.md': '# A\n' });
    nestedRepository(home, 'vendor/sub', true);
    lockedDirectory(home, 'vendor/sub/locked');
    const { off, on } = await bothArms({ home, baseDir: home });
    expect(on.refused, 'positive control: the stored population refuses it').toContain('locked');
    expect(off.refused).toContain('locked');
  });
});

/** The home crawled with the store off and on agrees on its declined links and its members. */
async function expectSameLinksAndMembers(home: string): Promise<void> {
  const { off, on } = await bothArms({ home, baseDir: home });
  expect(off.declinedLinks).toEqual(on.declinedLinks);
  expect(off.members).toEqual(on.members);
}

describe.skipIf(symlinkCapability() === null)('a declined link is the same condition with the store on or off', () => {
  it('a tracked directory link no markdown include names by itself', async () => {
    const symlinks = symlinkCapability();
    if (symlinks === null) return;
    const home = repository({ 'shared/rule.md': '# Rule\n', 'README.md': '# Home\n' });
    mkdirSyncReal(safePath.join(home, '.claude', 'rules'), { recursive: true });
    createSymlink(symlinks, '../../shared', safePath.join(home, '.claude', 'rules', 'shared'), 'dir');
    git(home, 'add', '-A');
    git(home, 'commit', '-q', '-m', 'link');
    const { off, on } = await bothArms({ home, baseDir: home });
    expect(on.declinedLinks, 'positive control: the stored population reports it').toEqual(['.claude/rules/shared']);
    expect(off.declinedLinks).toEqual(on.declinedLinks);
  });

  // The stored population's snapshot restages the working tree, so a link that
  // replaced a tracked file is a link to it, whatever the index held: a listing
  // that read the index mode would answer the commit while the store answers
  // the tree. The one exception, git's own, is `core.symlinks=false` (see
  // `linkIndexedAsPlainFile`).
  it('a tracked non-markdown file replaced by a directory link, under a markdown include', async () => {
    const symlinks = symlinkCapability();
    if (symlinks === null) return;
    const home = repository({ 'shared/rule.md': '# Rule\n', '.claude/rules/shared': 'placeholder\n', 'README.md': '# Home\n' });
    rmSync(safePath.join(home, '.claude', 'rules', 'shared'));
    createSymlink(symlinks, '../../shared', safePath.join(home, '.claude', 'rules', 'shared'), 'dir');
    const { off, on } = await bothArms({ home, baseDir: home, include: ['**/*.md'] });
    expect(on.declinedLinks, 'positive control: the stored population reports it').toEqual(['.claude/rules/shared']);
    expect(off.declinedLinks).toEqual(on.declinedLinks);
    expect(off.members).toEqual(on.members);
  });

  // Guards, not fixes: every lane a listing serves declines an ignored link
  // without a row, so neither the store nor the listing reports these.
  it('a link under an ignored directory', async () => {
    const symlinks = symlinkCapability();
    if (symlinks === null) return;
    const home = repository({ '.gitignore': 'build/\n', 'README.md': '# Home\n' });
    mkdirSyncReal(safePath.join(home, 'build'), { recursive: true });
    createSymlink(symlinks, '../README.md', safePath.join(home, 'build', 'alias.md'), 'file');
    await expectSameLinksAndMembers(home);
  });

  it('a link inside a nested repository', async () => {
    const symlinks = symlinkCapability();
    if (symlinks === null) return;
    const home = repository({ 'README.md': '# Home\n' });
    const sub = nestedRepository(home, 'vendor/sub', true);
    createSymlink(symlinks, 'README.md', safePath.join(sub, 'alias.md'), 'file');
    await expectSameLinksAndMembers(home);
  });
});

/**
 * A repository whose index holds `alias.md` at mode 120000 while the working
 * tree holds a plain file of the link's target text, which is what a checkout
 * with `core.symlinks=false` leaves. Staged with `update-index --cacheinfo`,
 * so no symlink support is needed and the cases run on Windows too.
 */
function linkIndexedAsPlainFile(symlinks: 'true' | 'false'): string {
  const home = repository({ 'README.md': '# Home\n' });
  writeFileSync(safePath.join(home, 'alias.md'), 'README.md');
  const oid = git(home, 'hash-object', '-w', 'alias.md').trim();
  git(home, 'update-index', '--add', '--cacheinfo', `120000,${oid},alias.md`);
  git(home, 'commit', '-q', '-m', 'link');
  git(home, 'config', 'core.symlinks', symlinks);
  return home;
}

describe('an index link whose working-tree path is a plain file', () => {
  // With core.symlinks=true git restages the plain file as a file, so the
  // stored population admits it, and a listing must not read the index mode.
  it('is a member either way with core.symlinks=true', async () => {
    const home = linkIndexedAsPlainFile('true');
    const { off, on } = await bothArms({ home, baseDir: home });
    expect(on.members, 'positive control: the stored population admits it').toContain('alias.md');
    expect(off.members).toEqual(on.members);
    expect(off.declinedLinks).toEqual(on.declinedLinks);
  });

  // What a Windows checkout without Developer Mode leaves: git keeps the index
  // mode 120000 for the plain file, and restages it so.
  it('is declined either way with core.symlinks=false', async () => {
    const home = linkIndexedAsPlainFile('false');
    const { off, on } = await bothArms({ home, baseDir: home });
    expect(on.declinedLinks, 'positive control: the stored population declines it').toEqual(['alias.md']);
    expect(off.declinedLinks).toEqual(on.declinedLinks);
    expect(off.members).toEqual(on.members);
  });
});

describe('a listing git did not answer', () => {
  // The stored lane reads its snapshot from the run's bracket, so moving `.git`
  // away after the snapshot leaves only the ignored listing to fail.
  it('refuses the stored population rather than reading it as nothing ignored', async () => {
    const home = repository({ 'a.md': '# A\n' });
    const thrown = await withGitSnapshotCache(async () => {
      // The key, as a store-on run takes it: the snapshot and its index flags are both read in the bracket.
      expect(gitTreeKey({ cwd: home }).ok, 'premise: the snapshot and its flags are in the bracket').toBe(true);
      renameSync(safePath.join(home, '.git'), safePath.join(home, '.git-away'));
      try {
        await new GitCrawlSource(home, []).enumerate();
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(thrown).toMatchObject({ code: GIT_NO_ANSWER_CODE });
  });
});

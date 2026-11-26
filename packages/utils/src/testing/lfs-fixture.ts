/**
 * A git repository whose files go through an emulated Git LFS filter: the one fixture builder the
 * LFS key tests (`utils`) and the LFS store tests (`cli`) share.
 *
 * The filter is the repository's emulated clean/smudge pair (`packages/utils/test/fixtures/lfs-filter.mjs`),
 * passed in by the suite, never a machine's git-lfs. Every git spawn this module makes runs with
 * {@link isolatedGitEnv}, so no system or user config (a machine's `filter.lfs.process`) reaches
 * it; a suite gives the same variables to whatever else it runs (`vi.stubEnv` in process, the
 * env of a spawned CLI). Every fixture file is backdated before each commit, refresh and emulated
 * pull, so no index entry is racily clean and a stat-clean entry is clean by stat, not by the clock.
 *
 * Framework-free, like everything under `testing/`: a refused git spawn throws.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { utimesSync, writeFileSync } from 'node:fs';

import { toForwardSlash } from '../path-core.js';
import { mkdirSyncReal, safePath } from '../path-utils.js';

import { gitExecutable } from './executables.js';
import { plantFiles } from './plant-files.js';

/** How far every backdate lies behind the clock, at least, in seconds. */
const BACKDATE_SECONDS = 10;

/** A repository under an emulated LFS filter, and the means to change it as a user would. */
export interface LfsFixtureRepo {
  /** The repository's root. */
  readonly repo: string;
  /** The git isolation variables every spawn against this repository needs ({@link isolatedGitEnv}). */
  readonly env: Readonly<Record<string, string>>;
  /** Run git in the repository with a commit identity; throws on a refusal. */
  git(...args: string[]): void;
  /** Move each file's mtime at least ten seconds back, to a second no earlier backdate used. */
  backdate(...relatives: string[]): void;
  /** Write `content` to `relative`, backdate it, and record its stat in the index (`git update-index --refresh`). */
  writeAndRefresh(relative: string, content: string): void;
  /** Configure the emulated filter as `filter.lfs.clean` and `filter.lfs.smudge`. */
  configureFilter(): void;
  /**
   * Write `content` to `relative`, backdate it, and stage it as the blob `blob`: what git-lfs's
   * clean makes of a file the emulated filter cannot clean (a non-canonical pointer's canonical
   * encoding on disk, a file an extension cleans). The emulated filter is configured afterwards.
   */
  stageAs(relative: string, content: string, blob: string): void;
  /** Plant `files`, backdate them, and commit them. */
  commit(files: Readonly<Record<string, string>>): void;
}

/**
 * The variables that keep git off the machine's config: no system config, and a home, XDG config
 * directory and global config inside the fixture.
 *
 * @param home - The fixture's home directory; its `.gitconfig` is the global config
 * @returns The variables
 */
export function isolatedGitEnv(home: string): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: home,
    XDG_CONFIG_HOME: safePath.join(home, '.config'),
    GIT_CONFIG_GLOBAL: safePath.join(home, '.gitconfig'),
  };
}

/**
 * The sha256 an LFS pointer names for `content`.
 *
 * @param content - The file's content
 * @returns The oid, hex
 */
export function lfsOidOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * A pointer's bytes for `content`, as the filter writes it.
 *
 * @param content - The file's content
 * @returns The pointer text
 */
export function lfsPointerOf(content: string): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${lfsOidOf(content)}\nsize ${Buffer.byteLength(content)}\n`;
}

/**
 * The filter command git runs through `sh`: this runtime and the script, double-quoted.
 *
 * @param filterScript - The emulated filter's path
 * @param mode - The filter's direction
 * @returns The command
 */
export function lfsFilterCommand(filterScript: string, mode: 'clean' | 'smudge' | 'clean-to'): string {
  return `"${toForwardSlash(process.execPath)}" "${toForwardSlash(filterScript)}" ${mode}`;
}

/**
 * Initialize a repository at `<dir>/repo` with its home at `<dir>/home`, `core.autocrlf=false`.
 *
 * @param options - Where, and which filter script
 * @param options.dir - An empty directory the fixture owns
 * @param options.filterScript - The emulated filter's path
 * @returns The fixture
 */
export function createLfsFixtureRepo(options: { readonly dir: string; readonly filterScript: string }): LfsFixtureRepo {
  const home = safePath.join(options.dir, 'home');
  const repo = safePath.join(options.dir, 'repo');
  mkdirSyncReal(home, { recursive: true });
  mkdirSyncReal(repo, { recursive: true });
  writeFileSync(safePath.join(home, '.gitconfig'), '');
  const env = isolatedGitEnv(home);
  let backdates = 0;

  // A plain spawn, not `runGit`: this subpath reaches no third-party package (`subpath-purity`).
  // The inherited `GIT_*` variables are dropped, as `runGit` drops them, so a hook's `GIT_DIR`
  // never aims the fixture's git at another repository.
  const spawnEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    ...env,
  };
  const git = (...args: string[]): void => {
    const result = spawnSync(gitExecutable(), ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      env: spawnEnv,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`, { cause: result.error });
  };
  const backdate = (...relatives: string[]): void => {
    backdates += 1;
    const seconds = Date.now() / 1000 - BACKDATE_SECONDS - backdates;
    for (const relative of relatives) utimesSync(safePath.join(repo, relative), seconds, seconds);
  };

  const configureFilter = (): void => {
    git('config', 'filter.lfs.clean', lfsFilterCommand(options.filterScript, 'clean'));
    git('config', 'filter.lfs.smudge', lfsFilterCommand(options.filterScript, 'smudge'));
  };

  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  return {
    repo,
    env,
    git,
    backdate,
    writeAndRefresh: (relative, content) => {
      writeFileSync(safePath.join(repo, relative), content);
      backdate(relative);
      git('update-index', '-q', '--refresh');
    },
    configureFilter,
    stageAs: (relative, content, blob) => {
      const blobFile = safePath.join(options.dir, 'clean-to.blob');
      writeFileSync(blobFile, blob);
      git('config', 'filter.lfs.clean', `${lfsFilterCommand(options.filterScript, 'clean-to')} "${toForwardSlash(blobFile)}"`);
      plantFiles(repo, { [relative]: content });
      backdate(relative);
      git('add', '--', relative);
      configureFilter();
    },
    commit: (files) => {
      plantFiles(repo, files);
      backdate(...Object.keys(files));
      git('add', '-A');
      git('commit', '-qm', 'fixture');
    },
  };
}

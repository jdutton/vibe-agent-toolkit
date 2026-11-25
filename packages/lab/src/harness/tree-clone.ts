/**
 * Copying a subject tree somewhere the lab owns, so a command that WRITES into
 * the tree it runs in never writes into a measured one.
 *
 * Two callers, one walk: the `verdict` facet's build-verb clone (an APFS
 * copy-on-write clone, macOS only, origin removed — `facets/verdict/clone.ts`)
 * and a measured command that writes the subject (`MeasuredCommandSpec.writes`,
 * `subject-copy.ts`). Both copy the tree minus sibling worktrees and regenerable
 * caches at any depth (`.turbo` took 4+ minutes) and keep `.git` and
 * `node_modules`.
 *
 * The plan is pure ({@link planTreeClone}) so every argv is unit-tested;
 * {@link executeClonePlan} is the thin I/O half.
 */

import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';

import { copyTree, fsFaultOf, isPathAbsentError, isTreeChangeResidue, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { NEVER_CRAWL_GLOBS } from '@vibe-agent-toolkit/utils/crawl';

import type { PreparationGit } from './arm-git.js';

/**
 * Never skipped though the crawler skips them: `.git` (the clone needs it) and
 * `node_modules` — the subject's build resolves npm bare specifiers (a config's
 * `frontmatterSchema`) through it, and `cp -R` keeps a relative workspace link
 * pointing into the clone. Without it a copied subject refuses where the real
 * one would not.
 */
const CLONED_ANYWAY: ReadonlySet<string> = new Set(['.git', 'node_modules']);

/**
 * The tree-relative suffixes never cloned: each literal {@link NEVER_CRAWL_GLOBS}
 * entry's directory, minus {@link CLONED_ANYWAY}. Derived, so a cache the
 * crawler learns to skip the clone skips too. The one wildcard entry — a build's
 * staging residue — is not a suffix, and is matched by name instead.
 */
const SKIPPED_SUFFIXES: readonly string[] = NEVER_CRAWL_GLOBS
  .map((glob) => glob.replace(/^\*\*\//u, '').replace(/\/\*\*$/u, ''))
  .filter((suffix) => !suffix.includes('*') && !CLONED_ANYWAY.has(suffix));

/**
 * @param relative - A tree-relative, forward-slashed path
 * @returns Whether the clone skips it
 */
function isSkippedFromClone(relative: string): boolean {
  return isTreeChangeResidue(relative.slice(relative.lastIndexOf('/') + 1))
    || SKIPPED_SUFFIXES.some((suffix) => relative === suffix || relative.endsWith(`/${suffix}`));
}

/** The link policy of a portable copy: a link stays a link, its target as written. */
const COPIED_LINKS = 'preserve';

/** Whether a tree carries git, and how. */
export type GitKind = 'directory' | 'file' | 'none';

/**
 * One directory of the source tree, as far as the plan must see it: its entry
 * names, and — by name — the subdirectories holding a skipped entry somewhere
 * beneath, which are descended rather than cloned whole.
 */
export interface CloneDir {
  readonly entries: readonly string[];
  readonly descend: Readonly<Record<string, CloneDir>>;
}

/** What the plan needs to know about the source tree. */
export interface CloneSource {
  /** Absolute subject root. */
  readonly path: string;
  /** The subject's alias, for a refusal. */
  readonly alias: string;
  readonly root: CloneDir;
  readonly git: GitKind;
}

/** One step of a clone. */
export type CloneStep =
  | { readonly kind: 'spawn'; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: 'mkdir'; readonly path: string }
  /** Copy one entry through the tree-change `copyTree`, links kept verbatim: no `cp` to spawn, so it runs on Windows. */
  | { readonly kind: 'copy'; readonly from: string; readonly to: string }
  /**
   * Re-stat every tracked file in the clone, so its index no longer holds the
   * source's mtime, ctime and inode: a copy moves them all, and the clone
   * reads stat-dirty until git looks again.
   */
  | { readonly kind: 'refresh-index'; readonly repository: string }
  /** Remove the clone's `origin` remote, when it has one. */
  | { readonly kind: 'remove-origin'; readonly repository: string };

/** A clone plan, or why there cannot be one. */
export type ClonePlan =
  | { readonly ok: true; readonly steps: readonly CloneStep[] }
  | { readonly ok: false; readonly refusal: string };

/**
 * How an entry is copied: `clone` is APFS copy-on-write (`cp -c`, macOS only),
 * `copy` a real copy through `cp -R`, `portable` a real copy through
 * `copyTree` (no spawn, so Windows has it). All keep a link as a link.
 */
export type CopyMode = 'clone' | 'copy' | 'portable';

/**
 * The steps copying `source` into `destination`, which must not exist yet.
 *
 * @param source - The subject tree, as listed
 * @param destination - The copy's root
 * @param mode - How each entry is copied
 * @returns The steps, in order; a repository's end with a `refresh-index`
 */
export function planTreeClone(source: CloneSource, destination: string, mode: CopyMode): CloneStep[] {
  const steps: CloneStep[] = [];
  planDir(source.root, source.path, destination, '', mode, steps);
  if (source.git === 'directory') steps.push({ kind: 'refresh-index', repository: destination });
  return steps;
}

/** The step copying one entry that is cloned whole. */
function copyStep(mode: CopyMode, from: string, to: string): CloneStep {
  if (mode === 'portable') return { kind: 'copy', from, to };
  return { kind: 'spawn', command: 'cp', args: [...(mode === 'clone' ? ['-c', '-R'] : ['-R']), from, to] };
}

/** Append the steps copying `dir` (at `relative` in the tree) from `from` into `to`. */
function planDir(
  dir: CloneDir,
  from: string,
  to: string,
  relative: string,
  mode: CopyMode,
  steps: CloneStep[],
): void {
  steps.push({ kind: 'mkdir', path: to });
  for (const entry of dir.entries) {
    const entryRelative = relative === '' ? entry : `${relative}/${entry}`;
    if (isSkippedFromClone(entryRelative)) continue;
    const child = dir.descend[entry];
    if (child === undefined) {
      steps.push(copyStep(mode, safePath.join(from, entry), safePath.join(to, entry)));
    } else {
      planDir(child, safePath.join(from, entry), safePath.join(to, entry), entryRelative, mode, steps);
    }
  }
}

/**
 * List what {@link planTreeClone} needs to know about a subject: a walk of its
 * directories (never following a link, never into a skipped entry or one of
 * {@link CLONED_ANYWAY}, which are cloned whole).
 *
 * @param path - Absolute subject root
 * @param alias - The subject's alias
 * @returns The listing, or a refusal naming a directory the OS would not list
 */
export function readCloneSource(
  path: string,
  alias: string,
): { readonly ok: true; readonly source: CloneSource } | { readonly ok: false; readonly refusal: string } {
  try {
    return { ok: true, source: { path, alias, root: readCloneDir(path, '').dir, git: kindOf(safePath.join(path, '.git')) } };
  } catch (error) {
    if (fsFaultOf(error) === undefined) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, refusal: `REFUSED: cannot list subject '${alias}' to copy it: ${detail}` };
  }
}

/** `dir`, and whether a skipped entry lies anywhere beneath it. */
function readCloneDir(path: string, relative: string): { dir: CloneDir; holdsSkipped: boolean } {
  const descend: Record<string, CloneDir> = {};
  const dirents = readdirSync(path, { withFileTypes: true });
  let holdsSkipped = false;
  for (const dirent of dirents) {
    const entryRelative = relative === '' ? dirent.name : `${relative}/${dirent.name}`;
    if (isSkippedFromClone(entryRelative)) {
      holdsSkipped = true;
    } else if (!dirent.isSymbolicLink() && dirent.isDirectory() && !CLONED_ANYWAY.has(dirent.name)) {
      // A link is never walked: `cp -R` copies it as a link.
      const child = readCloneDir(safePath.join(path, dirent.name), entryRelative);
      if (child.holdsSkipped) {
        descend[dirent.name] = child.dir;
        holdsSkipped = true;
      }
    }
  }
  return { dir: { entries: dirents.map((dirent) => dirent.name), descend }, holdsSkipped };
}

/**
 * @param path - A path
 * @returns Whether it is a directory, something else, or absent
 */
function kindOf(path: string): GitKind {
  try {
    return lstatSync(path).isDirectory() ? 'directory' : 'file';
  } catch (error) {
    if (isPathAbsentError(error)) return 'none';
    throw error;
  }
}

/**
 * Run a plan's steps in order, stopping at the first that fails.
 *
 * @param plan - An accepted plan
 * @param git - The arm's git (`arm-git.ts`), for the copy's index refresh and remote:
 *   under the developer's config a global `core.excludesFile` or a system
 *   `core.autocrlf` would decide what the copy's index records
 * @returns `null` on success, else a refusal naming the step that failed
 */
export function executeClonePlan(plan: Extract<ClonePlan, { ok: true }>, git: PreparationGit): Promise<string | null> {
  return executeFrom(plan.steps, 0, git);
}

/** Steps run one after another, each on what the last left: `index` onward, stopping at the first refusal. */
async function executeFrom(steps: readonly CloneStep[], index: number, git: PreparationGit): Promise<string | null> {
  const step = steps[index];
  if (step === undefined) return null;
  const failed = await executeStep(step, git);
  return failed ?? executeFrom(steps, index + 1, git);
}

/**
 * @param step - One step
 * @param git - The arm's git
 * @returns `null` on success, else a refusal naming the step
 */
function executeStep(step: CloneStep, git: PreparationGit): string | null | Promise<string | null> {
  switch (step.kind) {
    case 'mkdir': {
      mkdirSyncReal(step.path, { recursive: true });
      return null;
    }
    case 'copy': {
      return copyEntry(step.from, step.to);
    }
    case 'refresh-index': {
      // `-q` BEFORE `--refresh`: git applies options in order, so a trailing `-q`
      // is not yet read and a modified or skipped tracked file ("needs update")
      // would exit 1. Such a subject is the normal one, and its dirt must stay
      // visible in the clone. Through the arm's git, like remove-origin.
      const refreshed = git(['update-index', '-q', '--refresh'], step.repository);
      return refreshed.status === 0
        ? null
        : `REFUSED: cannot refresh the clone's index at ${step.repository} (git exit ${String(refreshed.status)}): ${refreshed.stdout} ${refreshed.stderr}`.trim();
    }
    case 'remove-origin': {
      // Through the arm's git, which clears an inherited GIT_DIR: a capture
      // launched from a hook must not edit the repository that is committing.
      // A clone with no origin already holds the state this step exists for.
      const remotes = git(['remote'], step.repository);
      if (remotes.status !== 0) return `REFUSED: cannot list the clone's remotes at ${step.repository}.`;
      if (!remotes.stdout.split('\n').includes('origin')) return null;
      return git(['remote', 'remove', 'origin'], step.repository).status === 0
        ? null
        : `REFUSED: cannot remove the clone's origin remote at ${step.repository}.`;
    }
    case 'spawn': {
      const result = spawnSync(step.command, step.args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (result.status === 0) return null;
      const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
      return `REFUSED: clone step '${step.command} ${step.args.join(' ')}' failed: ${result.error?.message ?? stderr}`;
    }
  }
}

/**
 * Copy the one entry `from` (a file, a link or a directory) to `to` through
 * `copyTree`, which copies a directory: walk `from`'s parent under a filter that
 * keeps only that entry, into `to`'s parent, which an earlier `mkdir` step made.
 * `links: 'preserve'` keeps a link a link with its target as written (a copier
 * that follows or absolutizes would point the copy back out of itself).
 *
 * @param from - The entry in the source tree
 * @param to - Where it goes; its parent exists and it does not
 * @returns `null` on success, else a refusal naming the entry
 */
async function copyEntry(from: string, to: string): Promise<string | null> {
  const name = from.slice(from.lastIndexOf('/') + 1);
  try {
    await copyTree(safePath.join(from, '..'), safePath.join(to, '..'), '', {
      links: COPIED_LINKS,
      side: 'source',
      onto: 'fresh',
      filter: (relative) => relative === name || relative.startsWith(`${name}/`),
    });
    return null;
  } catch (error) {
    if (fsFaultOf(error) === undefined) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    return `REFUSED: clone step 'copy ${from} ${to}' failed: ${detail}`;
  }
}

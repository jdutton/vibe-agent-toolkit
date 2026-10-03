/**
 * The APFS clone the `buildVerbs` verbs run in.
 *
 * `vat build`, `vat verify` and `vat claude marketplace publish --dry-run`
 * write into the tree they run in, and a measured tree must never receive
 * anything. So they run in a copy-on-write clone of the subject under a temp
 * directory outside every subject: `cp -c -R` per entry, minus sibling
 * worktrees and regenerable caches (`.turbo` took 4+ minutes) at any depth —
 * then `git remote remove origin`, so nothing a dry run does can reach a real
 * remote.
 *
 * ## Refusals
 *
 * - **Not macOS.** `cp -c` is an APFS clonefile; elsewhere there is no cheap
 *   clone, and a real copy of an adopter tree per arm is not what this facet
 *   promised. The refusal names `buildVerbs` so the fix is obvious.
 * - **A git worktree subject.** A worktree's `.git` is a FILE pointing into the
 *   main repository's git directory, whose `config` holds the remotes. A clone
 *   of that file shares it, so `git remote remove origin` in the clone would
 *   delete origin from the REAL repository. Point the subject at a full
 *   checkout, or set `buildVerbs: false`.
 *
 * The plan is pure ({@link planApfsClone}) so every refusal and every argv is
 * unit-tested; {@link executeClonePlan} is the thin I/O half.
 */

import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';

import { isFilesystemAccessError, isPathAbsentError, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { NEVER_CRAWL_GLOBS } from '@vibe-agent-toolkit/utils/crawl';

import { runGit } from '../../harness/git-state.js';

/**
 * Never skipped though the crawler skips them: `.git` (the clone needs it) and
 * `node_modules` — the subject's build resolves npm bare specifiers (a config's
 * `frontmatterSchema`) through it, and `cp -c -R` keeps a relative workspace
 * link pointing into the clone. Without it both arms refuse alike and the
 * delta reads a false zero.
 */
const CLONED_ANYWAY: ReadonlySet<string> = new Set(['.git', 'node_modules']);

/**
 * The tree-relative suffixes never cloned: each {@link NEVER_CRAWL_GLOBS}
 * entry's directory, minus {@link CLONED_ANYWAY}. Derived, so a cache the
 * crawler learns to skip the clone skips too.
 */
const SKIPPED_SUFFIXES: readonly string[] = NEVER_CRAWL_GLOBS
  .map((glob) => glob.replace(/^\*\*\//u, '').replace(/\/\*\*$/u, ''))
  .filter((suffix) => !CLONED_ANYWAY.has(suffix));

/**
 * @param relative - A tree-relative, forward-slashed path
 * @returns Whether the clone skips it
 */
function isSkippedFromClone(relative: string): boolean {
  return SKIPPED_SUFFIXES.some((suffix) => relative === suffix || relative.endsWith(`/${suffix}`));
}

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
  /** The subject's alias, for the refusal. */
  readonly alias: string;
  readonly root: CloneDir;
  readonly git: GitKind;
}

/** One step of a clone. */
export type CloneStep =
  | { readonly kind: 'spawn'; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: 'mkdir'; readonly path: string }
  /** Remove the clone's `origin` remote, when it has one. */
  | { readonly kind: 'remove-origin'; readonly repository: string };

/** A clone plan, or why there cannot be one. */
export type ClonePlan =
  | { readonly ok: true; readonly steps: readonly CloneStep[] }
  | { readonly ok: false; readonly refusal: string };

/**
 * Plan the clone of `source` into `destination`.
 *
 * @param source - The subject tree, as listed
 * @param destination - The clone root; must not exist yet
 * @param platform - `process.platform`, passed in so the refusal is testable
 * @returns The steps, in order, or a refusal
 */
export function planApfsClone(source: CloneSource, destination: string, platform: NodeJS.Platform): ClonePlan {
  if (platform !== 'darwin') {
    return {
      ok: false,
      refusal:
        `REFUSED: subject '${source.alias}' sets buildVerbs: true, which runs build/verify/publish in an ` +
        `APFS clone (cp -c) — macOS only, and this is ${platform}. Set buildVerbs: false for it here.`,
    };
  }
  if (source.git === 'file') {
    return {
      ok: false,
      refusal:
        `REFUSED: subject '${source.alias}' is a git worktree (its .git is a file), so a clone of it ` +
        "shares the main repository's config and 'git remote remove origin' would edit the REAL " +
        'repository. Point the subject at a full checkout, or set buildVerbs: false.',
    };
  }
  const steps: CloneStep[] = [];
  planDir(source.root, source.path, destination, '', steps);
  if (source.git === 'directory') {
    steps.push({ kind: 'remove-origin', repository: destination });
  }
  return { ok: true, steps };
}

/** Append the steps cloning `dir` (at `relative` in the tree) from `from` into `to`. */
function planDir(dir: CloneDir, from: string, to: string, relative: string, steps: CloneStep[]): void {
  steps.push({ kind: 'mkdir', path: to });
  for (const entry of dir.entries) {
    const entryRelative = relative === '' ? entry : `${relative}/${entry}`;
    if (isSkippedFromClone(entryRelative)) continue;
    const child = dir.descend[entry];
    if (child === undefined) {
      steps.push({ kind: 'spawn', command: 'cp', args: ['-c', '-R', safePath.join(from, entry), safePath.join(to, entry)] });
    } else {
      planDir(child, safePath.join(from, entry), safePath.join(to, entry), entryRelative, steps);
    }
  }
}

/**
 * List what {@link planApfsClone} needs to know about a subject: a walk of its
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
    if (!isFilesystemAccessError(error)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, refusal: `REFUSED: cannot plan the build-verb clone of subject '${alias}': ${detail}` };
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
      // A link is never walked: `cp -R` clones it as a link.
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
 * @returns `null` on success, else a refusal naming the step that failed
 */
export function executeClonePlan(plan: Extract<ClonePlan, { ok: true }>): string | null {
  for (const step of plan.steps) {
    const failed = executeStep(step);
    if (failed !== null) return failed;
  }
  return null;
}

/**
 * @param step - One step
 * @returns `null` on success, else a refusal naming the step
 */
function executeStep(step: CloneStep): string | null {
  switch (step.kind) {
    case 'mkdir': {
      mkdirSyncReal(step.path, { recursive: true });
      return null;
    }
    case 'remove-origin': {
      // Through the lab's runner, which scrubs an inherited GIT_DIR: a capture
      // launched from a hook must not edit the repository that is committing.
      // A clone with no origin already holds the state this step exists for.
      const remotes = runGit(['remote'], step.repository);
      if (remotes.status !== 0) return `REFUSED: cannot list the clone's remotes at ${step.repository}.`;
      if (!remotes.stdout.split('\n').includes('origin')) return null;
      return runGit(['remote', 'remove', 'origin'], step.repository).status === 0
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

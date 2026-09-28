/**
 * The APFS clone the `buildVerbs` verbs run in.
 *
 * `vat build`, `vat verify` and `vat claude marketplace publish --dry-run`
 * write into the tree they run in, and a measured tree must never receive
 * anything. So they run in a copy-on-write clone of the subject under a temp
 * directory outside every subject: `cp -c -R` per top-level entry, minus
 * `.claude/worktrees` (a checkout's sibling worktrees are not the subject, and
 * cloning them is the whole cost), then `git remote remove origin`, so nothing
 * a dry run does can reach a real remote.
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

import { isPathAbsentError, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

import { runGit } from '../../harness/git-state.js';

/** The directory under `.claude` that is never cloned. */
const WORKTREES_DIR = 'worktrees';

/** Whether a tree carries git, and how. */
export type GitKind = 'directory' | 'file' | 'none';

/** What the plan needs to know about the source tree. */
export interface CloneSource {
  /** Absolute subject root. */
  readonly path: string;
  /** The subject's alias, for the refusal. */
  readonly alias: string;
  /** Top-level entry names. */
  readonly entries: readonly string[];
  /** Entry names under `.claude`, or `null` when there is no `.claude` directory. */
  readonly claudeEntries: readonly string[] | null;
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
  const clone = (from: string, to: string): CloneStep => ({ kind: 'spawn', command: 'cp', args: ['-c', '-R', from, to] });
  const steps: CloneStep[] = [{ kind: 'mkdir', path: destination }];
  for (const entry of source.entries) {
    if (entry === '.claude' && source.claudeEntries !== null) continue;
    steps.push(clone(safePath.join(source.path, entry), safePath.join(destination, entry)));
  }
  if (source.claudeEntries !== null) {
    steps.push({ kind: 'mkdir', path: safePath.join(destination, '.claude') });
    for (const entry of source.claudeEntries) {
      if (entry === WORKTREES_DIR) continue;
      steps.push(clone(safePath.join(source.path, '.claude', entry), safePath.join(destination, '.claude', entry)));
    }
  }
  if (source.git === 'directory') {
    steps.push({ kind: 'remove-origin', repository: destination });
  }
  return { ok: true, steps };
}

/**
 * List what {@link planApfsClone} needs to know about a subject.
 *
 * @param path - Absolute subject root
 * @param alias - The subject's alias
 * @returns The listing
 */
export function readCloneSource(path: string, alias: string): CloneSource {
  const entries = readdirSync(path);
  return {
    path,
    alias,
    entries,
    claudeEntries: kindOf(safePath.join(path, '.claude')) === 'directory' ? readdirSync(safePath.join(path, '.claude')) : null,
    git: kindOf(safePath.join(path, '.git')),
  };
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

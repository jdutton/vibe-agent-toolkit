/**
 * The edit an edit arm makes before each measured repetition, and the arm
 * state that names it.
 *
 * An edit arm (`warm-edit<N>[:<kind>]`) is a warm arm whose every measured
 * repetition first edits N files of the tree (untimed), then runs its timed
 * steps, then restores the tree (untimed). Its time is a warm run after an
 * edit; the gap to a same-run clean warm arm of the same build is what an edit
 * costs (`facets/perf/gaps.ts`).
 *
 * - **Which files.** `--edit <path>` names them; otherwise the first N tracked
 *   `*.md` files with no frontmatter, in code-unit order — a file with
 *   frontmatter could carry a schema an appended line breaks, and a run that
 *   moved a finding would time a different run.
 * - **Every round's tree is one the store has not seen.** `modify` appends
 *   `\n<!-- lab edit round <r> -->\n`; `create` writes `lab-edit-<r>-<i>.md`
 *   beside the i-th file; `delete` removes a rotating window — round r deletes
 *   the N candidates from offset `r*N` (modulo the list) — so no two rounds
 *   delete the same files, and an arm whose rounds need more candidates than
 *   there are is refused before anything runs ({@link refuseUnplannableEdit}).
 *   A deleted file something links to moves a finding; the exit rule catches
 *   that, so point a delete arm at pages nothing links to, with `--edit`.
 * - **Every `--edit` path is a tracked file**, checked before priming: an
 *   untracked one cannot be restored by `git checkout`.
 * - **Restored however the round ends**: `modify` and `delete` by
 *   `git checkout -- <path>`, `create` by removing the file — only what the
 *   apply reached, and also when the apply itself failed.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { isUnderRoot, safePath } from '@vibe-agent-toolkit/utils';

import { armRefusal } from './arm-dirs.js';
import { runGit, trackedPaths } from './git-state.js';

/** What an edit does to each file it names. */
export type EditKind = 'modify' | 'create' | 'delete';

/** One edit arm's edit: how many files, what is done to them, and which (`null`: the first N tracked markdown files). */
export interface EditSpec {
  readonly kind: EditKind;
  readonly count: number;
  readonly paths: readonly string[] | null;
}

/** One file's edit, subject-relative with forward slashes. */
export type EditAction =
  | { readonly kind: 'modify'; readonly path: string; readonly append: string }
  | { readonly kind: 'create'; readonly path: string; readonly content: string }
  | { readonly kind: 'delete'; readonly path: string };

/** What an applied edit changed. */
export interface AppliedEdits {
  /** The paths the edit touched, in plan order. */
  readonly paths: readonly string[];
  /**
   * How many paths git reports changed after the apply (`git status --porcelain`, untracked files
   * included, so a created file counts): an edit that changed nothing says so.
   */
  readonly changed: number;
}

/**
 * Plan one round's edits.
 *
 * @param tracked - The candidate files (`editCandidates`), subject-relative
 * @param spec - The arm's edit
 * @param round - The measured round, 0-based; every round's bytes differ
 * @returns The actions, deterministic for one (tracked, spec, round)
 * @throws {VatError} `LAB_ARM_REFUSED` when the count is not a positive whole number or exceeds the candidates
 */
export function planEdits(tracked: readonly string[], spec: EditSpec, round: number): EditAction[] {
  if (!Number.isInteger(spec.count) || spec.count < 1) {
    throw armRefusal(`an edit arm edits a positive whole number of files; got ${String(spec.count)}`);
  }
  const candidates = [...(spec.paths ?? tracked)].sort(byCodeUnits);
  if (spec.count > candidates.length) {
    throw armRefusal(`warm-edit${String(spec.count)} edits ${String(spec.count)} files, but there are only ${String(candidates.length)} ${candidateSource(spec)}`);
  }
  // A delete window rotates so each round's tree is new; modify and create mark the round in their bytes.
  const offset = spec.kind === 'delete' ? (round * spec.count) % candidates.length : 0;
  const window = [...candidates, ...candidates].slice(offset, offset + spec.count);
  return window.map((path, index): EditAction => {
    if (spec.kind === 'modify') return { kind: 'modify', path, append: `\n<!-- lab edit round ${String(round)} -->\n` };
    if (spec.kind === 'delete') return { kind: 'delete', path };
    const directory = path.slice(0, path.lastIndexOf('/') + 1);
    return {
      kind: 'create',
      path: `${directory}lab-edit-${String(round)}-${String(index)}.md`,
      content: `# Lab edit ${String(round)} ${String(index)}\n`,
    };
  });
}

/**
 * @param spec - An arm's edit
 * @returns What its candidates are, for a refusal
 */
function candidateSource(spec: EditSpec): string {
  return spec.paths === null ? 'tracked markdown files with no frontmatter' : 'paths --edit names';
}

/**
 * Refuse, before anything runs, an edit no round of the invocation can make:
 * a count above the candidates, a delete arm whose rounds would repeat a
 * window (`rounds * N` above the candidates), or an `--edit` path that is not
 * a tracked file of the tree.
 *
 * @param root - The tree the arms run in
 * @param spec - One arm's edit (`paths` as `--edit` names them, or `null`)
 * @param rounds - The measured rounds
 * @throws {VatError} `LAB_ARM_REFUSED` naming the numbers or the path
 */
export function refuseUnplannableEdit(root: string, spec: EditSpec, rounds: number): void {
  const tracked = trackedPaths(root);
  if (tracked === null) throw armRefusal(`an edit arm needs a git tree; git could not list '${root}'`);
  const untracked = spec.paths?.find((path) => !tracked.has(path));
  if (untracked !== undefined) {
    throw armRefusal(`--edit '${untracked}' is not a tracked file of '${root}': git checkout could not restore it`);
  }
  const candidates = spec.paths ?? editCandidates(root);
  planEdits(candidates, spec, 0);
  if (spec.kind === 'delete' && rounds * spec.count > candidates.length) {
    throw armRefusal(
      `warm-edit${String(spec.count)}:delete over ${String(rounds)} rounds deletes ${String(rounds * spec.count)} distinct files, but there are only ${String(candidates.length)} ${candidateSource(spec)}`,
    );
  }
}

/**
 * Code-unit order, never a locale's: one machine's collation must not pick another machine's files.
 *
 * @param a - A path
 * @param b - Another
 * @returns Negative, zero or positive as `a` sorts before, with or after `b`
 */
function byCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * The files an edit arm with no `--edit` picks from: every tracked `*.md` file
 * with no frontmatter.
 *
 * @param root - The tree the arm runs in
 * @returns Subject-relative paths, unsorted
 * @throws {VatError} `LAB_ARM_REFUSED` when git cannot list the tree
 */
export function editCandidates(root: string): string[] {
  const tracked = trackedPaths(root);
  if (tracked === null) throw armRefusal(`an edit arm needs a git tree; git could not list '${root}'`);
  return [...tracked].filter(
    (path) => path.endsWith('.md') && !/^---\r?\n/u.test(readFileSync(safePath.join(root, path), 'utf-8')),
  );
}

/**
 * Apply one round's edits.
 *
 * @param root - The tree
 * @param actions - From {@link planEdits}
 * @param reached - Filled with every action that changed the tree or may have
 *   (a modify once its file was read, a create or delete once done), so the
 *   caller's restore undoes exactly those even when the apply throws part-way:
 *   `git checkout` of a path that was never there would fail the whole restore
 * @returns What changed
 * @throws {VatError} `LAB_ARM_REFUSED` when a path resolves outside the tree, before anything is written
 */
export function applyEdits(root: string, actions: readonly EditAction[], reached: EditAction[]): AppliedEdits {
  const outside = actions.find((action) => isUnderRoot(root, safePath.join(root, action.path)) === 'outside');
  if (outside !== undefined) throw armRefusal(`an edit arm edits '${outside.path}', which is outside the tree '${root}'`);
  for (const action of actions) {
    const path = safePath.join(root, action.path);
    if (action.kind === 'modify') {
      const before = readFileSync(path, 'utf-8');
      reached.push(action);
      writeFileSync(path, `${before}${action.append}`);
      continue;
    }
    // A create that fails found a file already there, which is not the edit's to remove.
    if (action.kind === 'create') writeFileSync(path, action.content, { flag: 'wx' });
    else rmSync(path);
    reached.push(action);
  }
  return { paths: actions.map((action) => action.path), changed: changedPaths(root) };
}

/**
 * Undo one round's edits.
 *
 * @param root - The tree
 * @param actions - What {@link applyEdits} applied
 * @returns Why the tree is not back to its commit, or `null`
 */
export function restoreEdits(root: string, actions: readonly EditAction[]): string | null {
  for (const action of actions) {
    if (action.kind === 'create') rmSync(safePath.join(root, action.path), { force: true });
  }
  const checkedOut = actions.filter((action) => action.kind !== 'create').map((action) => action.path);
  if (checkedOut.length > 0) {
    const restored = runGit(['checkout', '--', ...checkedOut], root);
    if (restored.status !== 0) return `git checkout of the edited files exited ${String(restored.status)}`;
  }
  const left = changedPaths(root);
  return left === 0 ? null : `restoring the edit left ${String(left)} changed path(s) in the tree`;
}

/**
 * @param root - The tree
 * @returns How many paths `git status --porcelain` reports, untracked files included
 */
function changedPaths(root: string): number {
  const status = runGit(['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'], root);
  return status.stdout.split('\0').filter((entry) => entry.length > 0).length;
}

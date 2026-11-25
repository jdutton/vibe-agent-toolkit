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
 * - **Every git here is the arm's** (`preparationGit`, `arm-git.ts`), a
 *   required parameter: under the developer's config a system
 *   `core.autocrlf=true` would rewrite a restored file's line endings and a
 *   global `core.excludesFile` would hide a created file from the count.
 * - **A file to edit that is not on disk is refused** with the arm refusal
 *   code, never a raw `ENOENT`.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { isPathAbsentError, isUnderRoot, safePath } from '@vibe-agent-toolkit/utils';

import { armRefusal } from './arm-dirs.js';
import { armTrackedPaths, type PreparationGit } from './arm-git.js';

/** A UTF-8 byte-order mark, which may precede a file's frontmatter. */
const BOM = String.fromCodePoint(0xfe_ff);

/** Frontmatter's opening fence, at the start of a file once any BOM is dropped. */
const FRONTMATTER_FENCE = /^---\r?\n/u;

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
 * @param git - The arm's git
 * @param root - The tree the arms run in
 * @param spec - One arm's edit (`paths` as `--edit` names them, or `null`)
 * @param rounds - The measured rounds
 * @throws {VatError} `LAB_ARM_REFUSED` naming the numbers or the path
 */
export function refuseUnplannableEdit(git: PreparationGit, root: string, spec: EditSpec, rounds: number): void {
  const tracked = armTrackedPaths(git, root);
  if (tracked === null) throw armRefusal(`an edit arm needs a git tree; git could not list '${root}'`);
  const untracked = spec.paths?.find((path) => !tracked.has(path));
  if (untracked !== undefined) {
    throw armRefusal(`--edit '${untracked}' is not a tracked file of '${root}': git checkout could not restore it`);
  }
  const candidates = spec.paths ?? editCandidates(git, root);
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
 * with no frontmatter (a BOM before the fence still counts as frontmatter).
 *
 * @param git - The arm's git
 * @param root - The tree the arm runs in
 * @returns Subject-relative paths, unsorted
 * @throws {VatError} `LAB_ARM_REFUSED` when git cannot list the tree, or a tracked `*.md` is missing from it
 */
export function editCandidates(git: PreparationGit, root: string): string[] {
  const tracked = armTrackedPaths(git, root);
  if (tracked === null) throw armRefusal(`an edit arm needs a git tree; git could not list '${root}'`);
  return [...tracked].filter((path) => path.endsWith('.md') && !hasFrontmatter(readEditable(root, path)));
}

/**
 * @param text - A file's text
 * @returns Whether it opens with a frontmatter fence, after any BOM
 */
function hasFrontmatter(text: string): boolean {
  return FRONTMATTER_FENCE.test(text.startsWith(BOM) ? text.slice(BOM.length) : text);
}

/**
 * @param root - The tree
 * @param path - A tree-relative file an edit reads
 * @returns Its text
 * @throws {VatError} `LAB_ARM_REFUSED` when it is not on disk
 */
function readEditable(root: string, path: string): string {
  try {
    return readFileSync(safePath.join(root, path), 'utf-8');
  } catch (error: unknown) {
    if (isPathAbsentError(error)) throw missingFromTree(root, path);
    throw error;
  }
}

/**
 * @param root - The tree
 * @param path - A file an edit names
 * @returns The refusal for a file git tracks that is not on disk
 */
function missingFromTree(root: string, path: string): Error {
  return armRefusal(`an edit arm edits '${path}', which is not in the work tree '${root}'`);
}

/**
 * Apply one round's edits.
 *
 * @param git - The arm's git
 * @param root - The tree
 * @param actions - From {@link planEdits}
 * @param reached - Filled with every action that changed the tree or may have
 *   (a modify once its file was read, a create or delete once done), so the
 *   caller's restore undoes exactly those even when the apply throws part-way:
 *   `git checkout` of a path that was never there would fail the whole restore
 * @returns What changed
 * @throws {VatError} `LAB_ARM_REFUSED` when a path resolves outside the tree, before anything is written, or a file to modify or delete is not on disk
 */
export function applyEdits(git: PreparationGit, root: string, actions: readonly EditAction[], reached: EditAction[]): AppliedEdits {
  const outside = actions.find((action) => isUnderRoot(root, safePath.join(root, action.path)) === 'outside');
  if (outside !== undefined) throw armRefusal(`an edit arm edits '${outside.path}', which is outside the tree '${root}'`);
  for (const action of actions) {
    const path = safePath.join(root, action.path);
    if (action.kind === 'modify') {
      const before = readEditable(root, action.path);
      reached.push(action);
      writeFileSync(path, `${before}${action.append}`);
      continue;
    }
    // A create that fails found a file already there, which is not the edit's to remove.
    if (action.kind === 'create') writeFileSync(path, action.content, { flag: 'wx' });
    else removeEditable(root, action.path);
    reached.push(action);
  }
  const changed = changedPaths(git, root);
  if (changed === null) throw armRefusal(`git status failed in '${root}' after an edit: the edit's change cannot be counted`);
  return { paths: actions.map((action) => action.path), changed };
}

/**
 * @param root - The tree
 * @param path - A tree-relative file a delete removes
 * @throws {VatError} `LAB_ARM_REFUSED` when it is not on disk
 */
function removeEditable(root: string, path: string): void {
  try {
    rmSync(safePath.join(root, path));
  } catch (error: unknown) {
    if (isPathAbsentError(error)) throw missingFromTree(root, path);
    throw error;
  }
}

/**
 * Undo one round's edits.
 *
 * @param git - The arm's git
 * @param root - The tree
 * @param actions - What {@link applyEdits} applied
 * @returns Why the tree is not back to its commit, or `null`
 */
export function restoreEdits(git: PreparationGit, root: string, actions: readonly EditAction[]): string | null {
  for (const action of actions) {
    if (action.kind === 'create') rmSync(safePath.join(root, action.path), { force: true });
  }
  const checkedOut = actions.filter((action) => action.kind !== 'create').map((action) => action.path);
  if (checkedOut.length > 0) {
    const restored = git(['checkout', '--', ...checkedOut], root);
    if (restored.status !== 0) return `git checkout of the edited files exited ${String(restored.status)}`;
  }
  const left = changedPaths(git, root);
  if (left === null) return `git status failed in '${root}' after the restore: the tree cannot be shown back at its commit`;
  return left === 0 ? null : `restoring the edit left ${String(left)} changed path(s) in the tree`;
}

/**
 * @param git - The arm's git
 * @param root - The tree
 * @returns How many paths `git status --porcelain` reports, untracked files included; `null` when git
 *   could not report (a failed status is no count of zero)
 */
function changedPaths(git: PreparationGit, root: string): number | null {
  const status = git(['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'], root);
  if (status.status !== 0) return null;
  return status.rawStdout.split('\0').filter((entry) => entry.length > 0).length;
}

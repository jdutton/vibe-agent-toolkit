/**
 * The arm's copy of the subject, for a sequence that WRITES the tree it runs in
 * (`vat build` writes `dist/`).
 *
 * A measured subject never receives anything. So an arm whose steps declare
 * `writes` runs in `<arm>/subject`, a copy made once per capture from the real
 * subject (APFS copy-on-write on macOS, a real copy on Linux), with every
 * written directory deleted inside it before each repeat — a repeat that found
 * the last one's `dist/` would time an incremental build — and the whole copy
 * removed when the arm's repeats end.
 *
 * ## Refusals
 *
 * - **Windows.** No `cp`; the copy is not implemented there.
 * - **A git worktree subject.** Its `.git` is a file pointing into the main
 *   repository's git directory, so git run in the copy would read and write the
 *   REAL repository's index for the worktree. Point the subject at a full
 *   checkout.
 * - **A subject nested below its repository's top level.** The copy is of the
 *   subject alone, so it carries no `.git`: vat in the copy would see an
 *   untracked tree, where vat in the subject sees a tracked one — a different
 *   command. Point the subject at the repository's top level, or at a tree no
 *   repository encloses. (Every arm's git also runs under
 *   `GIT_CEILING_DIRECTORIES` at the copy's parent, so a copy can never climb
 *   into a repository the arms root happens to sit inside.)
 * - **A written path that leaves the subject** — absolute, or climbing with `..`.
 */

import { hasParentTraversalSegment, isAbsolutePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { gitFindRoot } from '@vibe-agent-toolkit/utils/git';

import { armRefusal } from './arm-dirs.js';
import { type ClonePlan, executeClonePlan, readCloneSource, planTreeClone } from './tree-clone.js';

/**
 * Every subject-relative directory any of `steps` writes, each once.
 *
 * @param steps - A sequence's steps
 * @returns The written directories, in first-named order; empty when nothing writes
 * @throws {VatError} `ARM_REFUSED` naming a written path that would leave the subject
 */
export function writtenDirectories(steps: readonly { readonly name: string; readonly writes: readonly string[] }[]): string[] {
  const written: string[] = [];
  for (const step of steps) {
    for (const relative of step.writes) {
      if (relative === '' || isAbsolutePath(relative) || hasParentTraversalSegment(relative)) {
        throw armRefusal(`step '${step.name}' writes '${relative}', which is not a directory inside the subject`);
      }
      if (!written.includes(relative)) written.push(relative);
    }
  }
  return written;
}

/**
 * Plan the copy of `subject` into `destination`.
 *
 * @param subject - The real subject's absolute root
 * @param destination - The arm's copy; must not exist yet
 * @param platform - `process.platform`, passed in so the refusals are testable
 * @returns The plan, or a refusal
 */
export function planSubjectCopy(subject: string, destination: string, platform: NodeJS.Platform): ClonePlan {
  if (platform === 'win32') {
    return { ok: false, refusal: 'REFUSED: a command that writes its subject runs in a copy of it, and the lab cannot copy a tree on Windows.' };
  }
  const listed = readCloneSource(subject, subject);
  if (!listed.ok) return listed;
  if (listed.source.git === 'file') {
    return {
      ok: false,
      refusal:
        `REFUSED: subject '${subject}' is a git worktree (its .git is a file), so git run in a copy of it ` +
        "would read and write the REAL repository's index. Point the subject at a full checkout.",
    };
  }
  const top = gitFindRoot(subject);
  if (top !== null && toForwardSlash(top) !== toForwardSlash(subject)) {
    return {
      ok: false,
      refusal:
        `REFUSED: subject '${subject}' is inside the git repository at '${top}', not its top level, so a copy of ` +
        'it would carry no .git and vat in the copy would see an untracked tree. Point the subject at the ' +
        "repository's top level, or at a tree no repository encloses.",
    };
  }
  return { ok: true, steps: planTreeClone(listed.source, destination, platform === 'darwin' ? 'clone' : 'copy') };
}

/**
 * Copy `subject` into `destination`.
 *
 * @param subject - The real subject's absolute root
 * @param destination - The arm's copy; must not exist yet
 * @throws {VatError} `ARM_REFUSED` when the copy cannot be planned or made
 */
export function copySubject(subject: string, destination: string): void {
  const plan = planSubjectCopy(subject, destination, process.platform);
  const refusal = plan.ok ? executeClonePlan(plan) : plan.refusal;
  if (refusal !== null) throw armRefusal(refusal);
}

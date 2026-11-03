/**
 * The APFS clone the `buildVerbs` verbs run in.
 *
 * `vat build`, `vat verify` and `vat claude marketplace publish --dry-run`
 * write into the tree they run in, and a measured tree must never receive
 * anything. So they run in a copy-on-write clone of the subject under a temp
 * directory outside every subject — the harness's tree copy
 * (`harness/tree-clone.ts`) in `clone` mode — then `git remote remove origin`,
 * so nothing a dry run does can reach a real remote.
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
 * unit-tested.
 */

import { type ClonePlan, type CloneSource, planTreeClone } from '../../harness/tree-clone.js';

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
  const steps = planTreeClone(source, destination, 'clone');
  if (source.git === 'directory') {
    steps.push({ kind: 'remove-origin', repository: destination });
  }
  return { ok: true, steps };
}

/**
 * eval-suite-isolation.ts — keep the eval ANSWER KEY off the executor's filesystem.
 *
 * An eval suite (`evals.json` + its `fixtures/`) is authored TEST INPUT. Its
 * `expected_output` and `expectations` are the answer key for the very task the
 * executor is being asked to perform, so an executor that can read the suite can
 * find and paraphrase the answer instead of demonstrating the skill. That failure
 * is silent AND it fails in the direction that looks like success: evals PASS MORE,
 * the report goes green, and the signal is gone. Nothing downstream can detect it.
 *
 * The grader never needed the key on disk — it receives `expectations` /
 * `expectedOutput` in memory and stamps them into its own stdin prompt (see
 * eval-grader.ts). So the key has no reason to exist anywhere the executor can
 * reach, and this module makes sure it doesn't.
 *
 * WHERE THE KEY CAME FROM. Every way a subject reaches the harness used to carry
 * the suite into the staged tree:
 *   - a plain `{path}` source — the resolver copies the whole source dir;
 *   - a `vat build --only claude` plugin tree — the verbatim tree-copy shipped it;
 *   - an npm/url/vendored artifact — whatever the publisher included;
 *   - a `packageSkill` dist, which genuinely does NOT carry it — and the harness
 *     used to copy it back in on purpose so it could read the suite relative to
 *     the staged subject.
 * The fix inverts that last point: the harness reads the suite from the AUTHORED
 * source (or, for a fetched artifact with no authored copy, from a vat-only dir
 * outside the harness root), and the staged tree never holds it at all.
 *
 * WHY STRIP AT THE RESOLVER'S COPY. `stageHarness` calls this on each item's
 * `resolved.stagedDir` — the resolver's own copy under `<harnessRoot>/staged/` —
 * BEFORE `stageOneItem` copies that tree onward and before it is content-hashed.
 * Intervening at the single upstream copy means no later copy can carry the key,
 * the provenance hash describes the tree the executor actually sees, and there is
 * never a window in which the key exists in the sandbox.
 */

import { cpSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

/**
 * Where a skill's eval suite lives by convention. Defined here, beside the code
 * that must REMOVE it, because every lane that reasons about a suite needs the
 * same answer: the harness reads it, the packager excludes it, and staging
 * strips it. Three private copies of one string is how those lanes drift apart.
 */
export const DEFAULT_EVALS_SUBPATH = 'evals/evals.json';

/**
 * The path of the eval suite UNIT inside `skillDir`, or `undefined` when there
 * is nothing to strip — either because no eval suite was declared at all, or
 * because the configured subpath does not live inside the skill dir.
 *
 * The unit is the DIRECTORY containing `evals.json` (it also holds the suite's
 * `fixtures/`), except for a suite configured at the skill root (`evals: x.json`,
 * so `dirname` is `.`) where the unit is the single FILE — removing the skill dir
 * itself would obviously be wrong.
 *
 * `evalsSubpath` is `undefined` for a run whose subject declares no eval suite
 * at all (an optional adopter config field, never defaulted for a subject that
 * doesn't opt in) — that is a clean no-op, not an error: there is nothing to
 * strip. Fail-closed by construction either way: we only ever remove paths we
 * proved are inside, and a subpath that escapes (`../shared/evals/x.json` — a
 * deliberate and perfectly good layout that keeps suites out of the shipped
 * tree) also yields `undefined`, because nothing was ever staged inside the
 * skill dir to strip.
 */
export function evalSuiteUnitPath(skillDir: string, evalsSubpath: string | undefined): string | undefined {
  if (evalsSubpath === undefined) return undefined;
  const parent = dirname(evalsSubpath);
  const relative = parent === '.' || parent === '' ? evalsSubpath : parent;
  try {
    return safePath.joinUnderRoot(skillDir, relative);
  } catch {
    return undefined;
  }
}

/**
 * Throw unless `child` is inside `root`. Used as a last-line guard before any
 * removal: this module only ever deletes from the resolver's OWN staged copy
 * (every `resolveSkillSource` arm returns a `stageDirInto` result under
 * `ctx.stagingRoot`), and this asserts that invariant at the call site instead of
 * trusting it. If a future resolver ever returned a path to the user's real source
 * tree, this throws rather than deleting their authored evals.
 */
function assertInsideRoot(child: string, root: string): void {
  // `root` is typed `string`, but this is the last line of defense before a
  // recursive delete, so it does not get to assume its own precondition. A
  // partially-constructed context reaching here produced "The 'from' argument
  // must be of type string" from deep inside the path helpers — which reads as a
  // path-handling bug rather than as "the containment root is missing, so
  // nothing can be proven safe to delete."
  if (!root) {
    throw new TypeError(
      'isolateEvalSuite: stagingRoot is required. Refusing to remove an eval ' +
        'suite without a containment root proving the staged copy is ours.',
    );
  }
  safePath.joinUnderRoot(root, safePath.relative(root, child));
}

export interface IsolateEvalSuiteInput {
  /** The resolver's own staged copy of one skill (never the user's source tree). */
  stagedDir: string;
  /** Containment root `stagedDir` must live under — a violation throws, nothing is removed. */
  stagingRoot: string;
  /**
   * Suite subpath relative to a skill dir (e.g. `evals/evals.json`), or
   * `undefined` when this run's subject declares no eval suite at all —
   * an explicit, typed no-op case (nothing to strip) rather than an
   * accidental `undefined` arriving at runtime through a required `string`.
   */
  evalsSubpath: string | undefined;
  /**
   * When set, the suite is MOVED here instead of simply deleted. Passed for the
   * SUBJECT only, and only ever a vat-only directory OUTSIDE the harness root —
   * it is how the harness can still READ a suite that exists nowhere but inside a
   * fetched artifact (npm/url/vendored), without the executor being able to.
   * Companions get no hold dir: their suites are test input for a different skill
   * and are simply removed.
   */
  holdDir?: string;
}

/**
 * Strip one staged skill's eval suite, optionally preserving it out-of-band.
 *
 * Returns `true` only when a suite was found AND relocated into `holdDir` — i.e.
 * when the caller now has a readable copy there. Returns `false` when there was
 * no suite to strip (including when `evalsSubpath` is `undefined` — no suite
 * declared for this run, a clean no-op that never touches the staged dir), or
 * when it was removed without being preserved.
 *
 * Symlinks are not a concern here: the staged copy is produced by
 * `copyTreeNoSymlinks`, which refuses to copy any symlinked entry, so the unit is
 * always a real file or directory.
 */
export function isolateEvalSuite(input: IsolateEvalSuiteInput): boolean {
  const unit = evalSuiteUnitPath(input.stagedDir, input.evalsSubpath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- unit is proven inside our own staged dir
  if (unit === undefined || !existsSync(unit)) return false;

  assertInsideRoot(input.stagedDir, input.stagingRoot);

  let preserved = false;
  if (input.holdDir !== undefined) {
    mkdirSyncReal(input.holdDir, { recursive: true, mode: 0o700 });
    // A directory unit's CONTENTS become the hold dir's contents, so the suite file
    // lands at `<holdDir>/<basename(evalsSubpath)>` either way and `fixtures/` keep
    // their positions relative to it — exactly the shape the eval-input staging
    // expects from an authored evals dir.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- unit is proven inside our own staged dir
    const dest = lstatSync(unit).isDirectory() ? input.holdDir : safePath.join(input.holdDir, basename(unit));
    cpSync(unit, dest, { recursive: true });
    preserved = true;
  }

  rmSync(unit, { recursive: true, force: true });
  return preserved;
}

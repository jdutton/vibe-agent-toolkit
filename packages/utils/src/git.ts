/**
 * @vibe-agent-toolkit/utils/git
 *
 * Git primitives for build guards and gates: command execution, root discovery,
 * tracked-file enumeration, tree snapshots, gitignore evaluation, and git URL
 * parsing. Node-only — shells out to `git` and reads the filesystem.
 *
 * This is the ONLY published route to `runGit`. `safeExecSync`/`safeExecResult`
 * on `./process` refuse the `git` binary outright and point here, so a caller
 * that wants git gets the scrubbed environment rather than the ambient one by
 * construction. The scrub itself, and dirty-corrected tree snapshots, come from
 * `@vibe-validate/git`.
 *
 * The re-exports below are explicit rather than `export *` on purpose. A
 * blanket re-export surfaced TWO root finders under two names — `gitFindRoot`
 * and a `findGitRoot` alias whose entire body was `return gitFindRoot(startDir)`
 * — which guarantees half of all adopters reach for each.
 *
 * Curating this entry alone only moved the coin flip: `findGitRoot` stayed on
 * the `.` barrel, the entry with the most consumers, so both names remained
 * reachable from one import. The alias is now DELETED (pre-1.0 policy: remove
 * old code rather than maintain two APIs). `gitFindRoot` is the only root
 * finder in the package.
 */

// `gitIsMissing` is deliberately NOT here: classify git's silence through `gitNoAnswerFor` or, for a
// snapshot, `gitSnapshotFailureOf` — the one classifier — so no caller decides the cause with its own sentence.
export {
  runGit,
  runGitBytes,
  runGitOrThrow,
  type GitBytesRunResult,
  type GitRunOptions,
  type GitRunResult,
} from './git-run.js';
export {
  gitChangedFiles,
  type GitChangedFile,
  type GitChangedFilesRefusalKind,
  type GitChangedFilesResult,
  type GitChangeKind,
} from './git-changed-files.js';
export { gitFindRoot, gitLsFiles, gitLsOthers, isGitIgnored } from './git-utils.js';
export {
  GIT_FAILED_CODE,
  GIT_NO_ANSWER_CODE,
  GIT_NOT_FOUND_CODE,
  GIT_SNAPSHOT_OUTSIDE_SPARSE_CODE,
  GIT_SNAPSHOT_REFUSED_CODE,
  GIT_SNAPSHOT_UNREADABLE_CODE,
  gitNoAnswerError,
  gitNoAnswerFor,
  gitSnapshotError,
  gitSnapshotFailureOf,
  type GitNoAnswer,
  type GitNoAnswerCode,
} from './git-no-answer.js';
// The listings' REQUIRED `unreadable` option, typed here so a `./git`-only
// consumer can spell its policy without reaching for `./crawl`. The class is
// on `./crawl`, where every thrower and catcher of it already lives.
export type { RefuseListingContext, UnreadablePolicy } from './listing-refusal.js';
export {
  freshGitTreeSnapshot,
  gitTreeSnapshot,
  peekGitTreeSnapshot,
  withGitSnapshotCache,
  type GitSnapshotEntry,
  type GitSnapshotFailure,
  type GitSnapshotOutcome,
  type GitTreeSnapshot,
} from './git-snapshot.js';
export { loadGitignoreRules } from './gitignore-checker.js';
export { GitTracker, type GitTrackerInitOptions } from './git-tracker.js';
export {
  isGitUrl,
  nonInteractiveGitOverrides,
  parseGitUrl,
  type NonInteractiveGitOverrides,
  type ParsedGitUrl,
} from './git-url.js';

/**
 * @vibe-agent-toolkit/utils/git
 *
 * Git primitives for build guards and gates: root discovery, tracked-file
 * enumeration, gitignore evaluation, and git URL parsing. Node-only —
 * shells out to `git` and reads the filesystem.
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

export { gitFindRoot, gitLsFiles, gitLsOthers, isGitIgnored } from './git-utils.js';
export {
  gitTreeSnapshot,
  type GitSnapshotEntry,
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

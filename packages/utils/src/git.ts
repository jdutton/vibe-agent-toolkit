/**
 * @vibe-agent-toolkit/utils/git
 *
 * Git primitives for build guards and gates: root discovery, tracked-file
 * enumeration, gitignore evaluation, and git URL parsing. Node-only —
 * shells out to `git` and reads the filesystem.
 *
 * The re-exports below are explicit rather than `export *` on purpose. A
 * blanket re-export surfaced TWO root finders under two names — `gitFindRoot`
 * and the deprecated `findGitRoot` — which guarantees half of all adopters
 * reach for each. Only `gitFindRoot` is on this entry.
 *
 * `findGitRoot` (the deprecated alias in `gitignore-checker`, which just calls
 * `gitFindRoot`) remains available on the `.` barrel for existing callers.
 */

export { gitFindRoot, gitLsFiles, isGitIgnored } from './git-utils.js';
export { loadGitignoreRules } from './gitignore-checker.js';
export { GitTracker, type GitTrackerInitOptions } from './git-tracker.js';
export {
  isGitUrl,
  nonInteractiveGitOverrides,
  parseGitUrl,
  type NonInteractiveGitOverrides,
  type ParsedGitUrl,
} from './git-url.js';

/**
 * The one git every arm tree is touched with: a prepared clone's preparation and
 * proof, an arm's subject copy's index refresh, an edit arm's candidate listing,
 * its changed-path count and its restore, and the scratch arms' replays.
 *
 * It runs git the way the arms run VAT: through the lab's own {@link runCommand}
 * under {@link armStepEnvironment}. The developer's global git config, excludes,
 * `GIT_CONFIG_*` overrides and every name git exports into a hook are gone,
 * `HOME` is the empty arm home and `GIT_CONFIG_NOSYSTEM=1` keeps the machine's
 * system config out. The lab's `runGit` (`git-state.ts`) takes no environment,
 * so under it a system `core.autocrlf=true` rewrites a restored file's line
 * endings, a global `core.excludesFile` hides a created file from a count, and an
 * installed git-lfs filter replaces the lab's: an arm tree never sees it.
 */

import { type ArmDirectories, armStepEnvironment } from './arm-dirs.js';
import { runCommand } from './run.js';

/** One arm git's outcome: its exit (`null` when it never ran or was killed), and its streams. */
export interface ArmGitOutcome {
  readonly status: number | null;
  /** Stdout, trimmed. */
  readonly stdout: string;
  /** Stdout as git wrote it, for a `-z` listing whose first path may begin with a space. */
  readonly rawStdout: string;
  /** Stderr, trimmed. */
  readonly stderr: string;
}

/** One git run under an arm's environment. */
export type PreparationGit = (
  args: readonly string[],
  cwd: string,
  set?: Readonly<Record<string, string>>,
) => ArmGitOutcome;

/**
 * Git, run the way the arms run VAT (see this module's header).
 *
 * @param dirs - The arm whose home is git's global config
 * @param timeoutMs - Per-command ceiling, as for the steps
 * @returns The runner
 */
export function preparationGit(dirs: ArmDirectories, timeoutMs: number | undefined): PreparationGit {
  return (args, cwd, set = {}) => {
    const ran = runCommand({ command: 'git', leadingArgs: [] }, args, {
      cwd,
      env: armStepEnvironment(dirs, { set, unset: [] }).env,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return { status: ran.exitCode, stdout: ran.stdout.trim(), rawStdout: ran.stdout, stderr: ran.stderr.trim() };
  };
}

/**
 * Every path git tracks below `root`, through the arm's git, or `null` when git
 * could not say. `-z` and untrimmed, as `trackedPaths` (`git-state.ts`) reads it.
 *
 * @param git - The arm's git
 * @param root - The tree
 * @returns Tracked paths relative to `root`, or `null`
 */
export function armTrackedPaths(git: PreparationGit, root: string): ReadonlySet<string> | null {
  const listed = git(['ls-files', '-z'], root);
  if (listed.status !== 0) return null;
  return new Set(listed.rawStdout.split('\0').filter((path) => path.length > 0));
}

/**
 * What the store-size and touched-LFS arms share: one arm's directories under the
 * invocation's arms root, git run the way the arm's VAT runs (`preparationGit`,
 * the one arm-environment git), and one VAT step run under that same environment.
 *
 * Neither arm is a `perf arms` sequence: each walks a tree through states of its
 * own (a commit replayed, a file touched, an index refreshed) between single VAT
 * runs, so each drives {@link runArmVat} itself rather than `runRepeats`.
 */

import { type ArmDirectories, armDirectories, armRefusal, armStepEnvironment, prepareArmDirectories } from '../../harness/arm-dirs.js';
import { type PreparationGit, preparationGit } from '../../harness/clone.js';
import { type ExitCommitment, exitCommitmentViolation } from '../../harness/commands.js';
import { runCommand } from '../../harness/run.js';
import { STDERR_EXCERPT_CHARS } from '../../harness/sequence.js';
import type { ResolvedInstrument, RunResult } from '../../harness/types.js';

/** One build a scratch arm runs: its directory alias and its vat. */
export interface ScratchBuild {
  readonly alias: string;
  readonly instrument: ResolvedInstrument;
}

/** One scratch arm, its directories made. */
export interface ScratchArm {
  readonly dirs: ArmDirectories;
  /**
   * Git under the arm's environment: no system or global config, the arm's empty home. Never the
   * lab's `runGit` (`git-state.ts`): it takes no environment, so it runs under the developer's
   * global config, where an installed git-lfs's `filter.lfs.process` replaces the lab's filter, and
   * `GIT_CONFIG_NOSYSTEM` cannot be set.
   */
  readonly git: PreparationGit;
  readonly instrument: ResolvedInstrument;
  readonly timeoutMs: number | undefined;
}

/**
 * Make one warm arm's directories (`<armsRoot>/<alias>-<arm>-warm/`).
 *
 * @param armsRoot - The invocation's arms root
 * @param build - The build the arm runs
 * @param arm - The arm's name, a directory-name segment
 * @param timeoutMs - Per-command ceiling, or `undefined`
 * @returns The arm
 */
export function openScratchArm(armsRoot: string, build: ScratchBuild, arm: string, timeoutMs: number | undefined): ScratchArm {
  const dirs = armDirectories({ root: armsRoot, build: build.alias, arm, state: 'warm' });
  prepareArmDirectories(dirs);
  return { dirs, git: preparationGit(dirs, timeoutMs), instrument: build.instrument, timeoutMs };
}

/**
 * Run git under the arm, refusing on a non-zero exit.
 *
 * @param arm - The arm
 * @param args - Git's arguments
 * @param cwd - Where
 * @returns Git's trimmed stdout
 * @throws {VatError} `LAB_ARM_REFUSED` naming the command when git exits non-zero
 */
export function armGitOrRefuse(arm: ScratchArm, args: readonly string[], cwd: string): string {
  const ran = arm.git(args, cwd);
  if (ran.status !== 0) {
    throw armRefusal(`git ${args.join(' ')} exited ${String(ran.status)} in '${cwd}': ${ran.stderr.slice(0, STDERR_EXCERPT_CHARS)}`);
  }
  return ran.stdout;
}

/**
 * Run one VAT step under the arm's environment and hold it to its exit commitment.
 *
 * @param arm - The arm
 * @param args - VAT's arguments
 * @param cwd - Where
 * @param set - Variables layered over the arm's
 * @param exit - The exits that mean the step did its work (never 2)
 * @returns The run, its exit a committed one
 * @throws {VatError} `LAB_ARM_REFUSED` naming the step, its exit and its stderr otherwise
 */
export function runArmVat(
  arm: ScratchArm,
  args: readonly string[],
  cwd: string,
  set: Readonly<Record<string, string>>,
  exit: ExitCommitment,
): RunResult & { readonly exitCode: number } {
  const ran = runCommand(arm.instrument, args, {
    cwd,
    env: armStepEnvironment(arm.dirs, { set, unset: [] }).env,
    ...(arm.timeoutMs === undefined ? {} : { timeoutMs: arm.timeoutMs }),
  });
  const { exitCode } = ran;
  const violation = exitCode === null ? 'never exited (not run, or killed)' : exitCommitmentViolation(exit, exitCode);
  if (exitCode === null || violation !== null) {
    throw armRefusal(`vat ${args.join(' ')} in '${cwd}' ${violation ?? ''}: ${ran.stderr.slice(0, STDERR_EXCERPT_CHARS)}`);
  }
  return { ...ran, exitCode };
}

/**
 * build-hook.ts — optional pre-stage build step for `vat skill test run`.
 *
 * When the test config includes a `build:` field, this module runs that shell
 * command ONCE before staging so that generated artifacts (e.g. bundled scripts
 * not committed to source) are present in the source tree for staging to copy.
 *
 * The command runs with cwd = the CONFIG ROOT (the directory containing
 * vibe-agent-toolkit.config.yaml), because real build commands are root-level
 * package scripts (e.g. `pnpm bundle:report`).
 *
 * Security note: the `build:` field is a developer-authored value from the
 * project's own vibe-agent-toolkit.config.yaml — a trusted source under the
 * adopter's source control. The command is passed directly to the OS shell
 * (shell: true) intentionally, because build commands frequently include shell
 * syntax (npm script chaining, env vars, etc.). This is equivalent to running
 * `npm run build` or `pnpm bundle:report` from the terminal; it is NOT arbitrary
 * user input. The adopter is already executing skill code via this command
 * (`vat skill test run` requires --i-understand-this-runs-skill-code).
 */

import { spawnSync } from 'node:child_process';

/**
 * Options for the pre-stage build hook.
 *
 * `spawnFn` is injectable for unit testing — production code uses the default
 * (node:child_process spawnSync). Tests inject a vi.fn() mock.
 */
export interface BuildHookOptions {
  /** Shell command to run (from `test.build` in vibe-agent-toolkit.config.yaml). */
  buildCommand: string | undefined;
  /** Absolute path to the config root (cwd for the build command). */
  configRoot: string;
  /**
   * Injectable spawn function for unit testing.
   * Defaults to node:child_process spawnSync when not provided.
   */
  spawnFn?: (cmd: string, opts: { shell: boolean; cwd: string; stdio: 'inherit' }) => { status: number | null };
}

/** Thrown when the pre-stage build command exits with a non-zero code. Maps to preflight (exit 2). */
export class BuildHookError extends Error {
  readonly exitCode = 2 as const;
  constructor(message: string, public readonly buildExitCode: number) {
    super(message);
    this.name = 'BuildHookError';
  }
}

/**
 * Default spawn implementation: runs the command in a shell with stdio inherited.
 *
 * `build:` is a developer-authored shell command from the adopter's own config
 * (vibe-agent-toolkit.config.yaml), equivalent to running `pnpm bundle:report` at the
 * terminal. It is NOT arbitrary user input. The adopter already acknowledges running
 * skill code via --i-understand-this-runs-skill-code.
 */
function defaultSpawn(cmd: string, opts: { shell: boolean; cwd: string; stdio: 'inherit' }): { status: number | null } {
   
  return spawnSync(cmd, { ...opts, shell: true });
}

/**
 * Run the pre-stage build hook if configured.
 *
 * Runs `buildCommand` in a shell with `cwd = configRoot`. On non-zero exit,
 * throws `BuildHookError` with a clear message naming the command and exit code.
 * When `buildCommand` is undefined, this is a no-op (behavior unchanged).
 */
export function runPreStageBuild(opts: BuildHookOptions): void {
  const { buildCommand, configRoot } = opts;
  if (buildCommand === undefined) return;

  const spawn = opts.spawnFn ?? defaultSpawn;
  const result = spawn(buildCommand, { shell: true, cwd: configRoot, stdio: 'inherit' });
  const status = result.status ?? -1;

  if (status !== 0) {
    throw new BuildHookError(
      `Pre-stage build hook failed: command "${buildCommand}" exited with code ${status}. ` +
        `Resolve the build error before running vat skill test run.`,
      status,
    );
  }
}

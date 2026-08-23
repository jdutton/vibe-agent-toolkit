/**
 * The one way to run `git` — safe by construction, for VAT and for anyone
 * building on `@vibe-agent-toolkit/utils`.
 *
 * ## Why this exists rather than "remember to pass the right options"
 *
 * A `git` child inherits `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_PREFIX` and friends
 * from any ancestor `git` process, and **those override the `cwd` you passed**.
 * The result is not an error — it is a well-formed answer about a different
 * repository, at exit 0. Measured 2026-08-16 against real pre-commit hooks:
 *
 * - `git status --porcelain` at a caller-supplied path reported the *committing*
 *   repository's status, exit 0.
 * - `git init` in a fresh directory silently re-initialized the inherited
 *   `GIT_DIR` — no `.git` appeared where it was asked for — and the following
 *   `add`/`commit` landed in a **bystander repository**, switching its branch
 *   and rewriting its index, while every step reported success.
 * - `git rev-parse --show-toplevel` answered **correctly** throughout, so the
 *   obvious "am I in the right repository?" guard cannot detect any of it.
 *
 * The hazard is therefore invisible at every call site, which is exactly the
 * kind of thing that must be handled by the default rather than by discipline.
 *
 * ## The default is the whole design
 *
 * **The environment is scrubbed unless you say `ambient: true`.** Almost every
 * git command in a tool is about a path the caller was *handed* — a project
 * root, a temp staging repo, a clone destination — and for those the inherited
 * environment is always wrong. The rare command that genuinely means "the
 * repository I am standing in" (`git remote get-url` inside the user's own
 * checkout, say) opts out explicitly, and has to name itself when it does.
 *
 * ## What this is, mechanically: a set of defaults over `@vibe-validate/git`
 *
 * The spawn itself, the environment scrub and the treatment of a spawn-level
 * error all live in `executeGitCommand`, which is that package's single
 * chokepoint and is exercised by vibe-validate on every commit it gates. This
 * module supplies only the three defaults VAT needs to differ on, and a result
 * shape that never throws:
 *
 * - **`scrubGitEnv` is on unless `ambient: true`** — the inverse of
 *   `executeGitCommand`'s `false`. That default is right for vibe-validate,
 *   which mostly operates on the repository it was invoked in; it is wrong here,
 *   because VAT and its adopters are handed a root. Consolidating without this
 *   wrapper would relocate the opt-in rather than remove the hazard.
 * - **`maxBuffer` is 64 MiB, never Node's 1 MiB** (`executeGitCommand` defaults
 *   to 10 MiB). `git ls-files -s -z` emits ~104 bytes per path, so an
 *   8,500-file tree reaches 84% of Node's default and a larger one truncates.
 * - **A spawn-level failure is a failure regardless of exit status**, which
 *   `executeGitCommand` now enforces itself; `ok` simply forwards its `success`.
 *
 * ⚠️ **One property was given up in the consolidation:** this used to resolve the
 * binary with `which.sync('git')` and spawn an absolute path. `executeGitCommand`
 * spawns bare `'git'` and lets the OS search `PATH`, so a "git is not on PATH"
 * condition now arrives as an `ENOENT` in `error` rather than as a distinct
 * pre-spawn message. Both are reported through {@link GitRunResult}, so no caller
 * can mistake either for success.
 */

import { executeGitCommand } from '@vibe-validate/git';

/**
 * 64 MiB. Chosen against `git ls-files -s -z`, the widest-output command here:
 * ~104 bytes per path means this covers roughly 640,000 paths, while Node's
 * 1 MiB default covers about 10,000 — a ceiling ordinary monorepos reach.
 */
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/** Wall-clock ceiling on one invocation, so a hung remote cannot wedge a build. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** How to run one git command. */
export interface GitRunOptions {
  /**
   * Directory to run in. Honoured for real, because the inherited environment
   * that would otherwise override it is removed first.
   */
  cwd?: string;

  /**
   * Opt out of the scrub, for a command that genuinely means "the repository I
   * am standing in" rather than a path handed to it.
   *
   * ⚠️ Setting this inside a git hook makes the command operate on whatever the
   * outer `git` was operating on. That is occasionally what you want — and it is
   * never what you want when `cwd` names something specific.
   *
   * @default false
   */
  ambient?: boolean;

  /** Variables applied *after* the scrub, so a deliberate one survives. */
  env?: Record<string, string>;

  /** Milliseconds before the child is killed. @default 60000 */
  timeout?: number;

  /** Bytes of stdout/stderr to capture. @default 67108864 (64 MiB) */
  maxBuffer?: number;

  /** Data written to the child's stdin. */
  input?: string;

  /** Discard the child's stderr instead of capturing it. @default false */
  suppressStderr?: boolean;

  /**
   * Trim surrounding whitespace from `stdout` and `stderr`.
   *
   * **Pass `false` for a NUL-delimited (`-z`) listing.** git sorts by byte value
   * and 0x20 sorts below every printable character, so a path beginning with a
   * space is listed *first* — where the trim reaches it. The caller then holds a
   * path that does not exist, and every lookup against it reads as "not there"
   * rather than as an error. Also pass `false` when the output is file content
   * (`git show HEAD:file`), whose trailing newline is data.
   *
   * `ls-files -s -z` does not need it: the mode occupies position 0.
   *
   * @default true
   */
  trim?: boolean;
}

/** What one git command did. */
export interface GitRunResult {
  /**
   * True only when git actually ran **and** exited 0. A truncated or killed
   * child is never `ok`, whatever its exit status says.
   */
  ok: boolean;
  /**
   * Exit status, or `1` when the process never ran or was killed — the two are
   * not distinguishable here, so branch on {@link GitRunResult.error} rather
   * than on this when you need to tell a real `exit 1` from a failure to spawn.
   */
  status: number;
  /** Decoded stdout, trimmed. */
  stdout: string;
  /** Decoded stderr, trimmed — or the spawn failure's message when there is one. */
  stderr: string;
  /**
   * The spawn-level failure, when git could not run, was killed, or overran
   * `maxBuffer`. Present independently of `status`.
   */
  error?: Error;
}

/**
 * Run one `git` command.
 *
 * Never throws: a missing binary, a timeout and a non-zero exit are all reported
 * through {@link GitRunResult} so a caller can tell them apart and choose. Check
 * `ok`, not `status`.
 *
 * @param args - Arguments after the `git` executable, e.g. `['status', '--porcelain']`
 * @param options - See {@link GitRunOptions}; the environment is scrubbed unless
 *   `ambient` is set
 * @returns The outcome, including any spawn-level failure
 *
 * @example
 * ```typescript
 * // About a path you were handed — the ordinary case, safe by default.
 * const r = runGit(['status', '--porcelain'], { cwd: projectRoot });
 * if (!r.ok) throw new Error(`git status failed: ${r.stderr}`);
 * ```
 *
 * @example
 * ```typescript
 * // About the repository this process is standing in — opt out explicitly.
 * const url = runGit(['remote', 'get-url', 'origin'], { ambient: true });
 * ```
 */
export function runGit(args: readonly string[], options: GitRunOptions = {}): GitRunResult {
  if (args.length === 0) {
    // Handled here rather than by `executeGitCommand`, which THROWS on an empty
    // argv. This function's whole contract is that it never throws.
    return {
      ok: false,
      status: 1,
      stdout: '',
      stderr: 'runGit() needs at least one argument',
      error: new Error('runGit() needs at least one argument'),
    };
  }

  // `ignoreErrors` is what makes this non-throwing, and it is safe to set
  // unconditionally only because `executeGitCommand` now reports `error` on that
  // path too. Before that fix it dropped the spawn cause entirely, and a caller
  // reading the result could not tell "git is not installed" from "exit 1 is the
  // answer" from "your listing was truncated" — which is why this wrapper could
  // not have been written against the previous release.
  const result = executeGitCommand([...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.input === undefined ? {} : { stdin: options.input }),
    scrubGitEnv: options.ambient !== true,
    suppressStderr: options.suppressStderr ?? false,
    trimOutput: options.trim ?? true,
    ignoreErrors: true,
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
  });

  return {
    ok: result.success,
    status: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

/**
 * {@link runGit}, but a failure throws instead of being reported.
 *
 * For callers whose next line has no meaning if the command did not work —
 * setting up a fixture repository, or any step whose failure should stop the
 * run rather than be interpreted. Prefer {@link runGit} wherever a non-zero
 * exit carries information ("no commit yet", "not a repository", "no such
 * remote"), because those are answers rather than faults.
 *
 * @param args - Arguments after the `git` executable
 * @param options - See {@link GitRunOptions}
 * @returns The trimmed stdout
 * @throws {Error} When git could not run, or ran and exited non-zero
 */
export function runGitOrThrow(args: readonly string[], options: GitRunOptions = {}): string {
  const result = runGit(args, options);
  if (result.ok) return result.stdout;

  // The subcommand only: a commit message can be hundreds of KB, and
  // interpolating the whole argv buries the actual error in CI output.
  const label = args[0] ?? '<no args>';
  const detail = result.stderr || `exit ${String(result.status)}`;
  throw new Error(`git ${label} failed: ${detail}`);
}

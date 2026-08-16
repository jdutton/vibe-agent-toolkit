import { spawnSync, type SpawnSyncOptions } from 'node:child_process';

import which from 'which';

import { runGit } from './git-run.js';
import {
  buildWindowsShellLine,
  resolveShellCommandToken,
  shouldUseShell,
} from './windows-shell.js';

/**
 * Options for safe command execution
 */
export interface SafeExecOptions {
  /** Character encoding for output (default: undefined = Buffer) */
  encoding?: BufferEncoding;
  /** Standard I/O configuration */
  stdio?: 'pipe' | 'ignore' | 'inherit' | Array<'pipe' | 'ignore' | 'inherit'>;
  /**
   * The child's complete environment. It **replaces** `process.env` rather than
   * merging with it, so a partial object is a partial environment — build one
   * by spreading (`{ ...process.env, ... }`), or use {@link cleanGitEnv} when
   * the child is a `git` targeting a caller-supplied path.
   */
  env?: NodeJS.ProcessEnv;
  /** Working directory */
  cwd?: string;
  /** Maximum output buffer size in bytes */
  maxBuffer?: number;
  /** Timeout in milliseconds */
  timeout?: number;
  /**
   * Run `git` here instead of refusing it — for an argv the **operator supplied**
   * rather than one VAT composed.
   *
   * {@link refuseGit} exists because only the caller knows whether a git command
   * means the path it was handed or the repository it stands in, and VAT's own
   * call sites must say. That reasoning does not reach a command a user
   * configured: VAT neither composed it nor knows what it means, and refusing it
   * blocks a legitimate configuration rather than preventing a mistake.
   *
   * ⚠️ Setting this makes the git environment **your** problem. The one caller
   * that does — `link-auth`'s `defaultRunCommand` — strips every `GIT_*` key
   * case-insensitively before spawning, which is stricter than {@link runGit}'s
   * targeted scrub, not looser. Do not set it to silence the error.
   *
   * @default false
   */
  allowGit?: boolean;
}

/**
 * Result of a safe command execution
 */
export interface SafeExecResult {
  /** Whether the command exited successfully (status === 0) */
  success: boolean;
  /** Exit code (0 = success) */
  status: number;
  /** Standard output */
  stdout: Buffer | string;
  /** Standard error */
  stderr: Buffer | string;
  /** Error object if command failed to spawn */
  error?: Error;
}

/**
 * Error thrown when command execution fails
 */
export class CommandExecutionError extends Error {
  public readonly status: number;
  public readonly stdout: Buffer | string;
  public readonly stderr: Buffer | string;

  constructor(
    message: string,
    status: number,
    stdout: Buffer | string,
    stderr: Buffer | string,
  ) {
    super(message);
    this.name = 'CommandExecutionError';
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Refuse `git` here, and say where it belongs.
 *
 * "Safe" in this module's name has always meant *shell-injection*-safe: PATH
 * resolved once, no shell interpreter. It says nothing about the environment,
 * and `git` is the one command for which the environment silently decides which
 * repository the answer describes — `GIT_DIR` and `GIT_INDEX_FILE`, exported
 * into every child of a `git` hook, override the `cwd` passed here. The failure
 * is a well-formed answer about the wrong repository at exit 0, so no caller
 * discovers it by testing.
 *
 * A refusal rather than a silent scrub, because the two meanings are not
 * interchangeable: only the caller knows whether it means the path it passed or
 * the repository it stands in, and guessing on their behalf would be wrong half
 * the time in a way nothing reports. {@link runGit} makes them say.
 *
 * @param command - The command about to be spawned
 * @throws {Error} When the command is git
 */
function isGitCommand(command: string): boolean {
  const name = command.toLowerCase().replace(/\.(exe|cmd)$/, '');
  return name === 'git' || name.endsWith('/git') || name.endsWith(String.raw`\git`);
}

function refuseGit(command: string): void {
  if (!isGitCommand(command)) return;

  throw new Error(
    'Use runGit() from @vibe-agent-toolkit/utils to run git, not safeExecSync/safeExecResult.\n' +
      "  runGit(args, { cwd })                 — about a path you were handed (scrubs the inherited\n" +
      '                                          GIT_DIR/GIT_INDEX_FILE that would override cwd)\n' +
      '  runGit(args, { ambient: true })       — about the repository this process stands in\n' +
      'Inside a git hook the difference decides which repository you read — or write.',
  );
}

/**
 * Resolve command, build spawn options, and execute via spawnSync.
 *
 * Handles Windows shell requirements: `.cmd`/`.bat`/`.ps1` files need `shell:true`.
 * Node.js v24+ (DEP0190) rejects `shell:true` with a separate args array containing
 * shell metacharacters (`*`, `?`, `(`, `)`, etc.) with `EINVAL`. When shell mode is
 * needed, join command + args into a single string with per-arg quoting via
 * {@link windowsShellQuote} so metacharacters don't get re-interpreted by cmd.exe.
 *
 * The command token itself is chosen by {@link resolveShellCommandToken} — the same
 * helper the async {@link ./spawn-hardened.ts} path uses, so a bare PATH name stays bare
 * (cmd.exe re-resolves it via PATHEXT) while an explicit path is quoted from its resolved
 * value. Passing the raw command here used to break silently on `C:\Program Files\…`.
 */
function resolveAndSpawn(
  command: string,
  args: string[],
  options: SafeExecOptions,
): ReturnType<typeof spawnSync> {
  if (options.allowGit !== true) refuseGit(command);
  const commandPath = which.sync(command);
  const useShell = shouldUseShell(commandPath);

  const spawnOptions: SpawnSyncOptions = {
    shell: useShell,
    stdio: options.stdio ?? 'pipe',
    env: options.env,
    cwd: options.cwd,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    encoding: options.encoding,
  };

  if (!useShell) {
    return spawnSync(commandPath, args, spawnOptions);
  }

  const shellLine = buildWindowsShellLine(resolveShellCommandToken(command, commandPath), args);
  // eslint-disable-next-line sonarjs/os-command -- Windows DEP0190 workaround: command resolved via which.sync(); args are per-arg shell-quoted via windowsShellQuote()
  return spawnSync(shellLine, { ...spawnOptions, shell: true });
}

/**
 * Safe command execution using spawnSync + which pattern
 *
 * More secure than execSync:
 * - Resolves PATH once using pure Node.js (which package)
 * - Executes with absolute path and shell: false
 * - No shell interpreter = no command injection risk
 * - Supports custom env vars
 *
 * ⛔ **Not for `git`** — it throws. "Safe" here means shell-injection-safe and
 * says nothing about `GIT_DIR`/`GIT_INDEX_FILE`, which silently decide which
 * repository a git command answers about. Use `runGit()`.
 *
 * @param command - Command name (e.g., 'git', 'gitleaks', 'node')
 * @param args - Array of arguments
 * @param options - Execution options
 * @returns Buffer or string output
 * @throws Error if command not found or execution fails
 *
 * @example
 * // Tool detection
 * safeExecSync('gitleaks', ['--version'], { stdio: 'ignore' });
 *
 * @example
 * // Get output as string
 * const version = safeExecSync('node', ['--version'], { encoding: 'utf8' });
 *
 * @throws {Error} When `command` is git — use `runGit()` instead, which owns the
 *   inherited-environment problem this helper cannot see
 */
export function safeExecSync(
  command: string,
  args: string[] = [],
  options: SafeExecOptions = {},
): Buffer | string {
  const result = resolveAndSpawn(command, args, options);

  // Check for spawn errors
  if (result.error) {
    throw result.error;
  }

  // Check exit code
  if (result.status !== 0) {
    throw new CommandExecutionError(
      `Command failed with exit code ${result.status ?? 'unknown'}: ${command} ${args.join(' ')}`,
      result.status ?? -1,
      result.stdout,
      result.stderr,
    );
  }

  return result.stdout;
}

/**
 * Safe command execution that returns detailed result (doesn't throw)
 *
 * Use this when you need to handle errors programmatically
 * instead of catching exceptions.
 *
 * @param command - Command name (e.g., 'git', 'node')
 * @param args - Array of arguments
 * @param options - Execution options
 * @returns Detailed execution result
 *
 * @example
 * const result = safeExecResult('gh', ['pr', 'list']);
 * if (result.success) {
 *   console.log(result.stdout.toString());
 * } else {
 *   console.error(`Failed: ${result.stderr.toString()}`);
 * }
 *
 * @throws {Error} When `command` is git — use `runGit()` instead
 */
export function safeExecResult(
  command: string,
  args: string[] = [],
  options: SafeExecOptions = {},
): SafeExecResult {
  // Deliberately OUTSIDE the try: this is a programming error to fix at the call
  // site, not a command that failed. Folded into the result it would read as
  // "git is unavailable" and callers that treat a failure as information — most
  // of them — would carry on silently.
  if (options.allowGit !== true) refuseGit(command);

  try {
    const result = resolveAndSpawn(command, args, options);

    const status = result.status ?? -1;
    const execResult: SafeExecResult = {
      success: status === 0,
      status,
      stdout: result.stdout ?? Buffer.from(''),
      stderr: result.stderr ?? Buffer.from(''),
    };

    // Only include error property if it exists (exactOptionalPropertyTypes compliance)
    if (result.error) {
      execResult.error = result.error;
    }

    return execResult;
  } catch (error) {
    // which.sync throws if command not found
    return {
      success: false,
      status: -1,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Check if a command-line tool is available
 *
 * @param toolName - Name of tool to check (e.g., 'gh', 'gitleaks', 'node')
 * @returns true if tool is available, false otherwise
 *
 * @example
 * if (isToolAvailable('gh')) {
 *   console.log('GitHub CLI is installed');
 * }
 */
export function isToolAvailable(toolName: string): boolean {
  if (isGitCommand(toolName)) return probeVersion(toolName, '--version') !== null;
  try {
    safeExecSync(toolName, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask a binary its version, routing `git` around {@link refuseGit}.
 *
 * A version probe names the *executable*, never a repository, so the refusal
 * would be a false negative here — and a silent one, because both callers below
 * report "not installed" for a null. `vat doctor` did exactly that: correct
 * `git`, reported missing. {@link runGit} is the sanctioned path regardless.
 *
 * @param toolName - Binary to ask
 * @param versionArg - Argument that makes it print its version
 * @returns Trimmed version string, or null when the tool is genuinely absent
 */
function probeVersion(toolName: string, versionArg: string): string | null {
  if (isGitCommand(toolName)) {
    // The scrub is a no-op for a command that reads nothing; keeping the safe
    // default means no call site here has to reason about it.
    const result = runGit([versionArg]);
    return result.ok ? result.stdout : null;
  }
  try {
    const version = safeExecSync(toolName, [versionArg], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return (version as string).trim();
  } catch {
    return null;
  }
}

/**
 * Get tool version if available
 *
 * @param toolName - Name of tool (e.g., 'node', 'pnpm')
 * @param versionArg - Argument to get version (default: '--version')
 * @returns Version string or null if not available
 *
 * @example
 * const nodeVersion = getToolVersion('node');
 * console.log(nodeVersion); // "v20.11.0"
 *
 * @example
 * const gitVersion = getToolVersion('git', 'version');
 * console.log(gitVersion); // "git version 2.39.2"
 */
export function getToolVersion(
  toolName: string,
  versionArg: string = '--version',
): string | null {
  return probeVersion(toolName, versionArg);
}

/**
 * Shell syntax character sets for hyper-efficient single-pass detection
 *
 * Used by hasShellSyntax() and safeExecFromString() for shift-left validation.
 *
 * Performance: O(n) single pass with O(1) Set lookups - no regex backtracking.
 */
const QUOTE_CHARS = new Set(['"', "'", '`']);
const GLOB_CHARS = new Set(['*', '?', '[', ']']);
const OPERATOR_CHARS = new Set(['|', '>', '<', '&', ';']);

/**
 * Metadata for each shell syntax type (used for error messages)
 */
const SHELL_SYNTAX_METADATA = {
  quotes: { name: 'quotes', example: 'echo "hello"' },
  globs: { name: 'glob patterns', example: 'ls *.txt' },
  variables: { name: 'variable expansion', example: 'echo $HOME' },
  operators: { name: 'pipes/redirects/operators', example: 'cat file | grep text' },
} as const;

/**
 * Check if a command string contains shell-specific syntax
 *
 * Detects patterns that require shell interpretation:
 * - Quotes (", ', `)
 * - Glob patterns (*, ?, [])
 * - Variable expansion ($)
 * - Pipes/redirects/operators (|, >, <, &, ;, &&, ||)
 *
 * Performance: Single-pass O(n) algorithm with O(1) Set lookups.
 * Short-circuits on first match (no backtracking, no regex overhead).
 *
 * @param commandString - Command string to check
 * @returns Object with detection result and details
 *
 * @example
 * ```typescript
 * const check1 = hasShellSyntax('npm test');
 * console.log(check1); // { hasShellSyntax: false }
 *
 * const check2 = hasShellSyntax('npm test && npm run build');
 * console.log(check2);
 * // {
 * //   hasShellSyntax: true,
 * //   pattern: 'pipes/redirects/operators',
 * //   example: 'cat file | grep text'
 * // }
 * ```
 */
export function hasShellSyntax(commandString: string): {
  hasShellSyntax: boolean;
  pattern?: string;
  example?: string;
} {
  // Single-pass check with early return on first match
  for (const char of commandString) {

    // Check quotes: " ' `
    if (QUOTE_CHARS.has(char)) {
      return {
        hasShellSyntax: true,
        pattern: SHELL_SYNTAX_METADATA.quotes.name,
        example: SHELL_SYNTAX_METADATA.quotes.example,
      };
    }

    // Check glob patterns: * ? [ ]
    if (GLOB_CHARS.has(char)) {
      return {
        hasShellSyntax: true,
        pattern: SHELL_SYNTAX_METADATA.globs.name,
        example: SHELL_SYNTAX_METADATA.globs.example,
      };
    }

    // Check variable expansion: $
    if (char === '$') {
      return {
        hasShellSyntax: true,
        pattern: SHELL_SYNTAX_METADATA.variables.name,
        example: SHELL_SYNTAX_METADATA.variables.example,
      };
    }

    // Check operators: | > < & ;
    if (OPERATOR_CHARS.has(char)) {
      return {
        hasShellSyntax: true,
        pattern: SHELL_SYNTAX_METADATA.operators.name,
        example: SHELL_SYNTAX_METADATA.operators.example,
      };
    }
  }

  return { hasShellSyntax: false };
}

/**
 * Execute a command from a simple command string (convenience wrapper)
 *
 * **IMPORTANT: Shift-Left Validation** - This function actively rejects shell syntax
 * to prevent subtle bugs where shell features are expected but not executed.
 *
 * **Supported:**
 * - Simple commands: `git status`, `pnpm test`, `node --version`
 * - Commands with flags: `git log --oneline --max-count 10`
 * - Multiple unquoted arguments: `gh pr view 123`
 *
 * **NOT Supported (will throw error):**
 * - Quotes: `echo "hello world"` ❌
 * - Glob patterns: `ls *.txt` ❌
 * - Variable expansion: `echo $HOME` ❌
 * - Pipes/redirects: `cat file | grep text` ❌
 * - Command chaining: `build && test` ❌
 *
 * **Why these restrictions?**
 * We don't use a shell interpreter (for security), so shell features like
 * glob expansion, variable substitution, and pipes don't work. By detecting
 * and rejecting these patterns, we force you to use the safer `safeExecSync()`
 * API with explicit argument arrays.
 *
 * @param commandString - Simple command string (no shell syntax)
 * @param options - Execution options
 * @returns Command output (Buffer or string depending on encoding option)
 * @throws Error if command contains shell-specific syntax
 *
 * @example
 * ```typescript
 * // ✅ Simple commands (these work)
 * safeExecFromString('pnpm test --watch');
 * safeExecFromString('gh pr view 123');
 *
 * // ❌ git is refused here too — the string form is not a back door around
 * //    the chokepoint. Use runGit(['status'], { cwd }).
 * ```
 *
 * @example
 * ```typescript
 * // ❌ Shell syntax (these throw errors)
 * safeExecFromString('echo "hello"');         // Quotes
 * safeExecFromString('ls *.txt');             // Glob pattern
 * safeExecFromString('cat file | grep text'); // Pipe
 * safeExecFromString('echo $HOME');           // Variable expansion
 *
 * // ✅ Use safeExecSync() instead with explicit arguments
 * safeExecSync('echo', ['hello']);
 * safeExecSync('ls', ['file1.txt', 'file2.txt']); // Or use glob library
 * safeExecSync('grep', ['text', 'file']);
 * safeExecSync('echo', [process.env.HOME || '']);
 * ```
 *
 */
export function safeExecFromString(
  commandString: string,
  options: SafeExecOptions = {}
): Buffer | string {
  // Detect shell-specific syntax (shift-left validation)
  // This prevents subtle bugs where shell features are expected but not executed
  const check = hasShellSyntax(commandString);
  if (check.hasShellSyntax) {
    throw new Error(
      `safeExecFromString does not support ${String(check.pattern ?? 'unknown pattern')}.\n` +
        `Found in: ${commandString}\n\n` +
        `Use safeExecSync() with explicit argument array instead:\n` +
        `  // Bad: safeExecFromString('${String(check.example ?? 'command')}')\n` +
        `  // Good: safeExecSync('command', ['arg1', 'arg2'], options)\n\n` +
        `This ensures no shell interpreter is used and arguments are explicit.`
    );
  }

  const parts = commandString.trim().split(/\s+/);
  const command = parts[0];

  if (!command) {
    throw new Error('Empty command string');
  }

  const args = parts.slice(1);

  return safeExecSync(command, args, options);
}

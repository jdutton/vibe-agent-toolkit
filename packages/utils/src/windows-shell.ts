/**
 * Windows shell-invocation helpers, shared by every spawn wrapper in this package
 * ({@link ./safe-exec.ts} for the sync `spawnSync` path, {@link ./spawn-hardened.ts}
 * for the async streaming `spawn` path). Extracted so there is exactly ONE Windows
 * `.cmd`/`.bat`/`.ps1` convention across the toolkit — never two subtly-different
 * copies.
 *
 * Background: since the CVE-2024-27980 fix, Node's `child_process.spawn`/`spawnSync`
 * throw `EINVAL` when asked to launch a `.cmd`/`.bat` wrapper without `shell: true`.
 * npm-installed CLIs (`claude`, `npm`, `git` shims, …) resolve to exactly such a
 * wrapper on Windows, so any spawn that omits this handling crashes on Windows only.
 */

/**
 * Determine if shell should be used for command execution on Windows.
 *
 * ## Security Context
 *
 * This package's primary security model is `shell: false` to prevent command injection.
 * Windows requires `shell: true` only for shell scripts (.cmd/.bat/.ps1) which require
 * a shell interpreter by design (not executable binaries).
 *
 * ## Node.js on Windows - NO SHELL REQUIRED
 *
 * **Previous behavior (REMOVED):** Used shell:true for 'node' command
 * **Problem discovered:** Node.js DEP0190 deprecation warning - passing args array with
 * shell:true leads to incorrect command execution. Exit codes are ignored (always returns 0).
 *
 * **Testing shows:**
 * - ✅ `shell: false` + absolute path from `which.sync('node')` → Works correctly
 * - ❌ `shell: true` + args array → Exit codes ignored, security warning
 *
 * **Root Cause of Previous ENOENT Issues:** Likely resolved in newer Node.js versions.
 * Current testing (Node 20+) shows shell:false works correctly with absolute path.
 *
 * ## Why This Is Secure
 *
 * 1. **Minimal Shell Usage:** Shell only used for .cmd/.bat/.ps1 files (required)
 * 2. **Path Validation:** Command paths resolved via `which.sync()` before execution
 * 3. **Array-Based Arguments:** Arguments passed as array, preventing injection
 * 4. **Controlled Environment:** Commands from trusted configuration, not user input
 * 5. **No String Interpolation:** Never concatenate user input into command strings
 *
 * ## References
 *
 * - Node.js deprecation: https://nodejs.org/api/deprecations.html#DEP0190
 * - Security tests: `packages/utils/test/safe-exec.test.ts`
 * - Windows fix: PR #94 (fix/windows-shell-independence-v2)
 *
 * @param commandPath - Resolved absolute path to command
 * @returns true if shell should be used, false otherwise
 */
export function shouldUseShell(commandPath: string): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  // Node.js deprecation warning (DEP0190): Passing args with shell:true leads to incorrect
  // command execution and security vulnerabilities. Testing shows shell:false works correctly
  // with absolute path from which.sync('node') on Windows.
  // Previous ENOENT issues may have been resolved in newer Node.js versions.
  //
  // REMOVED: if (command === 'node') return true;
  // Reason: shell:true causes exit codes to be ignored (always returns 0)
  // Fix: Use shell:false with absolute path - works correctly

  // Windows shell scripts require shell by design (case-insensitive check)
  const lowerPath = commandPath.toLowerCase();
  return lowerPath.endsWith('.cmd') || lowerPath.endsWith('.bat') || lowerPath.endsWith('.ps1');
}

/**
 * Quote a single argument for a Windows `cmd.exe` command line.
 *
 * Rules:
 *   - An arg that's empty, or contains whitespace, quotes, or any of `& | < > ^ ( ) % !`,
 *     gets wrapped in double quotes.
 *   - Embedded double quotes become `""` (cmd.exe's escape form inside quoted strings).
 *
 * This is narrow on purpose: it's only used when we're forced to assemble a shell string
 * for `.cmd` / `.bat` wrappers on Windows (DEP0190 path). Callers still control what's
 * in `args`, but this keeps a stray space, glob metachar, or paren from getting
 * re-interpreted by the shell.
 */
export function windowsShellQuote(arg: string): string {
  if (arg === '' || /["\s&|<>^()%!]/.test(arg)) {
    return `"${arg.replaceAll('"', '""')}"`;
  }
  return arg;
}

/**
 * Build the single `cmd.exe` command line used when a Windows shim forces shell mode
 * (Node's DEP0190 rejects `shell: true` with a separate args array, so command + args
 * must be one string). `commandToken` is the already-resolved command — a bare PATH
 * name that `cmd.exe` re-resolves via PATHEXT, or a pre-quoted explicit path — and each
 * arg is quoted via {@link windowsShellQuote} so shell metacharacters can't re-interpret.
 */
export function buildWindowsShellLine(commandToken: string, args: string[]): string {
  return `${commandToken} ${args.map(windowsShellQuote).join(' ')}`;
}

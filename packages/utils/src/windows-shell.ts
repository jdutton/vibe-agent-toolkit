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

import { isAbsoluteAnyPlatform } from './path-core.js';

/**
 * A `command` is treated as an explicit path (used verbatim, never PATH-resolved)
 * when it is absolute or contains a path separator. A bare name (`claude`, `npm`,
 * `git`) is resolved on PATH via `which.sync`. This mirrors — and preserves — the
 * behaviour callers relied on before hardening: an explicit `binPath` is spawned
 * as-given (so a nonexistent path still surfaces as an async `'error'` event, not a
 * synchronous `which` throw), while a bare command is looked up.
 */
export function isPathLike(command: string): boolean {
  return isAbsoluteAnyPlatform(command) || command.includes('/') || command.includes('\\');
}

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
 * ## Why This Is Secure — and where it is only *quoted*, not secure
 *
 * There are two modes, and they have genuinely different properties. Describing them as
 * one ("arguments are always an array", "we never interpolate") would be false for this
 * module's own Windows branch, which does exactly that interpolation.
 *
 * 1. **Minimal Shell Usage:** the shell is used ONLY when this function returns true —
 *    `.cmd` / `.bat` / `.ps1`, where a shell interpreter is required by design.
 * 2. **Path Validation:** command paths are resolved via `which.sync()` before execution.
 * 3. **Two modes:**
 *    - **`shell: false` (every other command — the default):** arguments are handed to
 *      `spawn`/`spawnSync` as a real argv array. Nothing re-parses them, so there is no
 *      metacharacter surface at all. This is the mode that is *secure*.
 *    - **`shell: true` (this function returning true):** Node's DEP0190 forbids an args
 *      array in shell mode, so {@link buildWindowsShellLine} MUST concatenate the command
 *      and its arguments into a single string. Safety there rests entirely on
 *      {@link windowsShellQuote}, which *quotes* — it does not neutralize. `%VAR%` still
 *      expands inside double quotes, and an argument containing a `"` unavoidably desyncs
 *      `cmd.exe`'s quote tracking (that function documents the two-parser trade in full).
 * 4. **Controlled Environment:** commands and arguments come from trusted configuration.
 *    On the `shell: true` branch that is a *requirement*, not a nicety — do not route
 *    untrusted input through it; spawn with `shell: false` and an args array instead.
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
 * Characters that force an argument to be wrapped in double quotes: whitespace, a quote,
 * and `cmd.exe`'s metacharacters. Also the predicate {@link buildWindowsShellLine} uses to
 * decide whether an *unquoted* command token is safe — "a token {@link windowsShellQuote}
 * would have left alone" is exactly the token cmd.exe cannot split or re-interpret.
 */
const SHELL_QUOTE_TRIGGER = /["\s&|<>^()%!]/;

/**
 * Quote a single argument for a Windows `cmd.exe` command line.
 *
 * Rules (the canonical `CommandLineToArgvW` algorithm — the same one used by .NET's
 * `PasteArguments`, Python's `subprocess.list2cmdline`, and Rust's `Command`):
 *   - An arg that's empty, or contains whitespace, quotes, or any of `& | < > ^ ( ) % !`,
 *     gets wrapped in double quotes.
 *   - Every run of backslashes that immediately precedes a `"` — an embedded one OR the
 *     closing one — is doubled.
 *   - Embedded double quotes are escaped as `\"`.
 *
 * ## Why backslash runs must be doubled before EVERY quote, not just the last one
 *
 * `CommandLineToArgvW` — what the launched program uses to split the line back into argv —
 * reads a backslash run only in relation to the character that follows it: `2n`
 * backslashes before a `"` mean `n` literal backslashes plus a *delimiter* quote; `2n+1`
 * mean `n` literal backslashes plus a *literal* quote; a run followed by anything else is
 * literal. So a backslash sitting in front of a quote silently changes what that quote
 * means, and the parse desynchronizes from there — the argument swallows the rest of the
 * line, or a backslash vanishes.
 *
 * The everyday cases are not exotic: `C:\Program Files\` (a directory path with a trailing
 * separator and a space) and `{"dir":"C:\\tools\\"}` (JSON carrying a Windows path). A
 * previous version of this function handled only the *trailing* run and escaped quotes as
 * `""`. Replaying it through the reference parser in `test/windows-shell.test.ts` over every
 * string in `{a, \, ", space, %}` of length ≤ 4 corrupted 85 of 781 inputs, 74 of which
 * swallowed the following argument; every failure contained a backslash-quote sequence. That
 * harness now runs on every commit, and asserts 0 of 781.
 *
 * ## TWO PARSERS IN SERIES: why `\"` and not `""` (the deliberate trade)
 *
 * The string this function emits is consumed by two different parsers, in order:
 *
 *   1. **`cmd.exe`**, which has NO backslash escape at all. It toggles a quote flag on
 *      every `"` it sees, and only text inside that flag is protected from `& | < > ^ ( )`.
 *   2. **`CommandLineToArgvW`** (or the CRT's equivalent) in the process the `.cmd`/`.bat`
 *      shim ultimately launches. The dominant real case is an npm shim forwarding `%*` to
 *      a real `.exe`, and `%*` is the *verbatim* remaining text — so whatever we emit here
 *      is exactly what that second parser sees.
 *
 * These two want opposite things, and no single byte sequence satisfies both:
 *
 *   - `""` keeps `cmd.exe`'s quote count even, so metacharacters stay protected — but its
 *     meaning to the second parser is version- and implementation-dependent. It is absent
 *     from `CommandLineToArgvW`'s documented ruleset (which specifies only the backslash
 *     rules), and under the widely-mirrored `CommandLineToArgvW` implementation — where a
 *     run of three quotes yields one literal quote and *resets* the quote state — the token
 *     `"a""b"` leaves the parser back inside quotes, so the following space stops
 *     separating arguments and the next argument is swallowed.
 *   - `\"` is understood identically by every implementation there is (CommandLineToArgvW,
 *     old and new CRT, .NET, Python, Rust, Wine). But `cmd.exe` does not honour the
 *     backslash, so each embedded quote flips its quote flag: within an argument that
 *     contains a `"`, the span following that quote is *outside* cmd's quotes and a
 *     metacharacter there would be re-interpreted.
 *
 * **The trade made here: `\"`.** Delivering the argument to the child process byte-exact is
 * the job of this function, and `\"` is the only form with no parser-variant risk. The cost
 * is bounded and stated plainly: for an argument containing BOTH a `"` and one of
 * `& | < > ^ ( )`, `cmd.exe` may act on that metacharacter. Arguments with no embedded
 * quote — which is every path, and the trailing-backslash case that motivated all of this —
 * emit exactly two quotes and keep cmd's tracking balanced, so they are unaffected.
 *
 * (Rust makes the opposite trade in `append_bat_arg`, emitting `""`. Its target is a batch
 * file reading `%~1` *itself*, where cmd is the only parser and injection is the whole
 * threat model. Ours is a shim forwarding `%*` to an `.exe`, where the second parser is the
 * one that decides what the program actually receives. Same two parsers, different consumer,
 * different answer.)
 *
 * ## These characters are QUOTED, NOT NEUTRALIZED
 *
 * Wrapping in double quotes stops `cmd.exe` from re-interpreting whitespace and the
 * redirection/pipe/grouping metacharacters — but it does **not** stop variable
 * expansion. `cmd.exe` expands `%VAR%` *inside* double quotes, so:
 *
 *   - an arg containing `%PATH%` is still substituted before the program sees it, and
 *   - a literal `%` in a filename (legal on Windows) can be corrupted by that pass.
 *
 * `%` is in the trigger class only so such args get quoted at all; treat the value as
 * still shell-visible. `!` has the same shape under delayed expansion (`!VAR!`) — that
 * is off by default for `cmd /c`, so it is a caveat rather than a live bug, but a
 * caller that enables `ENABLEDELAYEDEXPANSION` inherits the problem. If an argument
 * must survive verbatim, do not route it through a shell at all: spawn with
 * `shell: false` and a real args array (see {@link shouldUseShell}).
 *
 * This is narrow on purpose: it's only used when we're forced to assemble a shell string
 * for `.cmd` / `.bat` wrappers on Windows (DEP0190 path). Callers still control what's
 * in `args`, but this keeps a stray space, glob metachar, or paren from getting
 * re-interpreted by the shell.
 */
export function windowsShellQuote(arg: string): string {
  if (arg !== '' && !SHELL_QUOTE_TRIGGER.test(arg)) {
    return arg;
  }

  // Walk the argument, holding each backslash run until we see what follows it: a run
  // before a quote (embedded, or the closing one) is doubled so the quote keeps its own
  // meaning; a run before anything else is literal and emitted as-is.
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      // 2n backslashes (now literal) + one more to escape the quote => 2n+1.
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }
  // Trailing run: doubled, so the closing quote terminates the argument instead of being
  // escaped by it (`"C:\Program Files\"` would otherwise swallow the next argument).
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

/**
 * Choose the `commandToken` to hand {@link buildWindowsShellLine} on the Windows shell
 * path. This is the ONE definition of that choice — both spawn wrappers
 * ({@link ./safe-exec.ts} and {@link ./spawn-hardened.ts}) call it, so the two paths are
 * provably identical rather than merely similar. They previously disagreed: the sync path
 * emitted a raw, unquoted command, which silently broke on any explicit path containing a
 * space (and now throws, thanks to the assertion in `buildWindowsShellLine`).
 *
 * Two cases, and they need opposite treatment:
 *
 *   - **Bare PATH name** (`claude`, `npm`) — emitted verbatim, NOT quoted and NOT replaced
 *     by the resolved path, because `cmd.exe` must be left to re-resolve it through
 *     `PATHEXT`. A bare name has no whitespace, so it never trips the assertion.
 *   - **Explicit path** (absolute, or containing a separator) — the RESOLVED path, run
 *     through {@link windowsShellQuote} so a directory with a space (`C:\Program Files\…`)
 *     stays one token, and a trailing backslash cannot escape the closing quote and
 *     swallow the next argument.
 *
 * @param command - The command as the caller supplied it (decides bare vs. explicit).
 * @param resolvedPath - The path actually being launched (what gets quoted, when quoted).
 */
export function resolveShellCommandToken(command: string, resolvedPath: string): string {
  return isPathLike(command) ? windowsShellQuote(resolvedPath) : command;
}

/**
 * Is `token` a single `cmd.exe` token — one thing cmd will treat as the command, with no
 * way for it to split or re-interpret the rest?
 *
 * Two admissible shapes, and nothing else:
 *
 *   - **Unquoted:** a token {@link windowsShellQuote} would have left alone — no
 *     whitespace, no quote, no metacharacter. A bare PATH name (`claude`, `npm`) or a
 *     space-free path.
 *   - **Quoted:** exactly ONE balanced outer pair with no further quote inside it, e.g.
 *     `"C:\Program Files\tool.cmd"`. Stripping that pair must leave a body cmd cannot
 *     escape from.
 *
 * The interior-quote check is the whole point. The previous predicate was "starts with `"`
 * and ends with `"`", which is true of an entire crafted command line —
 * `"a b" && calc "x"` — so a caller could hand over something that runs `calc` and this
 * function would wave it through as "already quoted".
 *
 * The empty string is neither shape, and needs saying because it slipped between both
 * branches: `''` does not start with `"`, and `SHELL_QUOTE_TRIGGER` cannot match a string
 * with no characters, so the metacharacter branch returned true. `buildWindowsShellLine('',
 * ['calc', 'b'])` was accepted and emitted `" calc b"` — a line whose first cmd.exe token
 * is `calc`, i.e. the caller's first *argument* silently promoted into the command
 * position. The explicit length check is what makes "one token" mean *one*, not *at most
 * one*. (Whitespace-only tokens were already rejected — `\s` is in the trigger class.)
 */
function isSingleShellToken(token: string): boolean {
  if (token.length === 0) {
    return false;
  }
  if (token.startsWith('"')) {
    return token.length >= 2 && token.endsWith('"') && !token.slice(1, -1).includes('"');
  }
  return !SHELL_QUOTE_TRIGGER.test(token);
}

/**
 * Build the single `cmd.exe` command line used when a Windows shim forces shell mode
 * (Node's DEP0190 rejects `shell: true` with a separate args array, so command + args
 * must be one string). `commandToken` is the already-resolved command — a bare PATH
 * name that `cmd.exe` re-resolves via PATHEXT, or a pre-quoted explicit path — and each
 * arg is quoted via {@link windowsShellQuote} so shell metacharacters can't re-interpret.
 *
 * `commandToken` is emitted verbatim (quoting it here would defeat the PATHEXT lookup a
 * bare name relies on), so quoting it is the caller's job — see
 * {@link resolveShellCommandToken}, which is how every caller should produce it. An
 * unquoted path containing a space — `C:\Program Files\tool.cmd` — would otherwise produce
 * a silently broken line where `cmd.exe` tries to run `C:\Program` with `Files\tool.cmd` as
 * its first argument. Those cases throw rather than emitting the broken line.
 *
 * @throws {Error} if `commandToken` is not a single `cmd.exe` token (see
 *   {@link isSingleShellToken}). Pass it through {@link windowsShellQuote} first.
 */
export function buildWindowsShellLine(commandToken: string, args: string[]): string {
  if (!isSingleShellToken(commandToken)) {
    throw new Error(
      `buildWindowsShellLine: commandToken is not a single cmd.exe token: ${commandToken}. ` +
        'It must be either a bare name with no whitespace/quote/metacharacter, or one ' +
        'balanced double-quoted token with no quote inside it. Wrap it with ' +
        'windowsShellQuote() first — cmd.exe would otherwise split it or run part of it ' +
        'as a separate command.',
    );
  }
  return `${commandToken} ${args.map(windowsShellQuote).join(' ')}`;
}

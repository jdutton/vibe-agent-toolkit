/**
 * Token resolution — ordered, first-non-empty-wins.
 *
 * Iterates a provider's `token` source list and returns the first source that
 * yields a non-empty value. Two source shapes:
 *   - `{ env: "NAME" }`                — read from process env (no trimming)
 *   - `{ command: argv }`              — run a command, return trimmed stdout
 *   - `{ command: "gh auth token" }`   — convenience: whitespace-tokenized into
 *     argv. **Not** passed through a shell — operators (`|`, `&&`, `$(...)`)
 *     become literal argv elements, per the design's §6.1 sharp-edge note.
 *
 * Command sources can be disabled at runtime with `VAT_LINKAUTH_ALLOW_COMMAND=0`
 * (or by passing `allowCommand: false` in deps). Useful in security-sensitive
 * environments where arbitrary command execution is undesirable.
 *
 * Returns `undefined` if every source fails or yields an empty/whitespace
 * value — the caller's `resolveAuthenticatedUrl` translates that to the
 * `unverified` outcome (surfaced as `LINK_AUTH_UNVERIFIED` by the validator).
 *
 * Per design issue #113 §4 (token vocabulary) and §6.1 (command execution,
 * `safeExecSync`-backed, `shell: false`).
 */

import { safeExecResult } from '../safe-exec.js';

export type TokenSource = { readonly env: string } | { readonly command: string | readonly string[] };

export interface TokenResolutionDeps {
  /**
   * Environment lookup map. Defaults to `process.env`. Injectable for tests so
   * unit tests don't depend on ambient environment state.
   */
  readonly env: Record<string, string | undefined>;

  /**
   * Command runner. Defaults to `safeExecResult`-wrapped invocation. Injectable
   * for tests. Receives argv; returns `success` + `stdout`. Should NOT throw
   * for normal exec failures (return `success: false` instead). Throws are
   * propagated by `resolveToken` — they indicate operator-level bugs.
   */
  readonly runCommand: (argv: readonly string[]) => { success: boolean; stdout: string };

  /**
   * Whether `{ command: ... }` sources are allowed. Defaults to
   * `process.env['VAT_LINKAUTH_ALLOW_COMMAND'] !== '0'`. Set to `false` (or
   * export `VAT_LINKAUTH_ALLOW_COMMAND=0`) to skip all command sources and rely
   * solely on env-var sources — useful in locked-down CI or security reviews.
   */
  readonly allowCommand: boolean;
}

/**
 * Default `runCommand` implementation — exported so callers that want to
 * memoize per-validate-run can wrap it without duplicating the spawn logic.
 * Forwards to `safeExecResult` (no shell, argv-based).
 *
 * Strips `GIT_*` env vars before spawning so token commands like `gh auth token`
 * work correctly from inside git pre-commit hooks, where git sets `GIT_DIR`,
 * `GIT_WORK_TREE`, and similar vars that confuse nested git calls.
 */
export const defaultRunCommand: TokenResolutionDeps['runCommand'] = (argv) => {
  if (argv.length === 0) return { success: false, stdout: '' };
  const [bin, ...args] = argv;
  if (bin === undefined) return { success: false, stdout: '' };
  // Case-insensitive on the key so Windows env vars (which are case-insensitive
  // at the OS level, though `process.env` preserves original case) can't sneak
  // through as e.g. `Git_Dir`.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')),
  ) as NodeJS.ProcessEnv;
  const result = safeExecResult(bin, [...args], { encoding: 'utf8', env });
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
  return { success: result.success, stdout };
};

/**
 * Resolve a token from an ordered list of sources.
 *
 * @returns the first non-empty value, or `undefined` if every source failed.
 * @throws whatever the injected `runCommand` throws (operator-level bug; not
 *   swallowed). Standard `safeExecResult` does not throw under normal use.
 */
export function resolveToken(
  sources: readonly TokenSource[],
  deps?: Partial<TokenResolutionDeps>,
): string | undefined {
  const env = deps?.env ?? process.env;
  const runCommand = deps?.runCommand ?? defaultRunCommand;
  const allowCommand = deps?.allowCommand ?? (process.env['VAT_LINKAUTH_ALLOW_COMMAND'] !== '0');

  for (const source of sources) {
    if (!allowCommand && 'command' in source) continue;
    const value = tryResolveSource(source, env, runCommand);
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function tryResolveSource(
  source: TokenSource,
  env: Record<string, string | undefined>,
  runCommand: TokenResolutionDeps['runCommand'],
): string | undefined {
  if ('env' in source) {
    // Object.hasOwn defends against env names like "__proto__" returning
    // Object.prototype via the prototype chain.
    if (!Object.hasOwn(env, source.env)) return undefined;
    return env[source.env];
  }

  const argv = toArgv(source.command);
  if (argv.length === 0) return undefined;

  const result = runCommand(argv);
  if (!result.success) return undefined;
  const trimmed = result.stdout.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function toArgv(command: string | readonly string[]): readonly string[] {
  if (Array.isArray(command)) return command;
  // Whitespace-tokenize the string form. Empty segments (from multiple spaces)
  // are filtered. Shell operators ('|', '&&', etc.) become literal argv, NOT
  // pipes — see design §6.1.
  return (command as string).split(/\s+/).filter((s) => s.length > 0);
}

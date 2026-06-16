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
}

const DEFAULT_RUN_COMMAND: TokenResolutionDeps['runCommand'] = (argv) => {
  if (argv.length === 0) return { success: false, stdout: '' };
  const [bin, ...args] = argv;
  if (bin === undefined) return { success: false, stdout: '' };
  const result = safeExecResult(bin, [...args], { encoding: 'utf8' });
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
  const runCommand = deps?.runCommand ?? DEFAULT_RUN_COMMAND;

  for (const source of sources) {
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

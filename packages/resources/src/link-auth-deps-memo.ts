/**
 * Memoization wrapper for linkAuth `runCommand`-shaped token resolvers.
 *
 * Token resolution can be expensive — `gh auth token` spawns a subprocess on
 * every call, env-source reads are cheap but consistent treatment is simpler
 * to reason about — so the validator and the content-fetch primitive both
 * wrap their `runCommand` once per session. Identical argv tuples return the
 * cached result; distinct argv tuples are run independently.
 *
 * Lifetime of the memo is the lifetime of the returned `LinkAuthDeps` —
 * one-per-session, never module-global. Callers that want a fresh resolve
 * (e.g. token rotation between runs) construct a fresh validator / primitive
 * call and get a fresh memo.
 *
 * Lifted out of `external-link-validator.ts` (where it shipped first in #125)
 * so the slice-3 content-fetch primitive shares the same implementation —
 * see CLAUDE.md "code duplication policy" (jscpd would flag a clone).
 *
 * Per design issue #113 review on PR #125 (memoize all token sources, not
 * just `command` sources).
 */

import { defaultRunCommand, type resolveAuthenticatedUrl } from '@vibe-agent-toolkit/utils';

/**
 * Re-exposed deps type — the third argument to `resolveAuthenticatedUrl`.
 * Mirrors the engine's `Partial<TokenResolutionDeps>` without importing the
 * private type name.
 */
export type LinkAuthDeps = Parameters<typeof resolveAuthenticatedUrl>[2];

/**
 * Wrap a `LinkAuthDeps` so its `runCommand` (used by the engine's
 * `resolveToken`) caches results per unique argv. Without this, validating N
 * URLs from the same host re-runs the token command N times.
 *
 * Caches by JSON-stringified argv so semantically-identical invocations
 * share. The cache is per-call-site (one Map per wrapper); callers that share
 * across multiple `resolveAuthenticatedUrl` invocations should call this
 * once and reuse the wrapped object.
 */
export function wrapLinkAuthDepsWithMemo(deps: LinkAuthDeps): NonNullable<LinkAuthDeps> {
  type RunCommandFn = NonNullable<NonNullable<LinkAuthDeps>['runCommand']>;
  type RunCommandResult = ReturnType<RunCommandFn>;
  const memo = new Map<string, RunCommandResult>();
  const baseRunCommand: RunCommandFn = deps?.runCommand ?? defaultRunCommand;
  const runCommand: RunCommandFn = (argv) => {
    const key = JSON.stringify(argv);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const fresh = baseRunCommand(argv);
    memo.set(key, fresh);
    return fresh;
  };
  return { ...(deps ?? {}), runCommand };
}

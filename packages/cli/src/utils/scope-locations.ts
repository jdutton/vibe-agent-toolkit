/**
 * Scope locations and validation for agent installation
 */

import { getClaudeUserPaths } from '@vibe-agent-toolkit/claude-marketplace';
import { safePath } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError } from './command-refusal.js';

/**
 * Map of runtime to scope resolvers. Each resolves when it is called, never at
 * module load: `--cwd` changes the working directory after every module is
 * loaded, and the user scope is whatever the one Claude-user-paths resolver
 * says (it honours `CLAUDE_CONFIG_DIR`).
 */
const SCOPE_RESOLVERS: Record<string, Record<string, () => string>> = {
  'agent-skill': {
    user: () => getClaudeUserPaths().skillsDir,
    project: () => safePath.join(process.cwd(), '.claude', 'skills'),
  },
};

/**
 * `record[key]` for an OWN key only. `runtime` and `scope` are user input: a
 * plain index reads `constructor`, `toString` and `__proto__` off
 * `Object.prototype`, which once turned `--runtime constructor` into a crash.
 */
function ownEntry<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The scope directories of `runtime`, resolved now; `undefined` for an unknown runtime. */
export function scopeLocationsFor(runtime: string): Record<string, string> | undefined {
  const resolvers = ownEntry(SCOPE_RESOLVERS, runtime);
  if (!resolvers) return undefined;
  return Object.fromEntries(Object.entries(resolvers).map(([scope, resolve]) => [scope, resolve()]));
}

/** The runtimes that have scope locations. */
export function knownScopeRuntimes(): string[] {
  return Object.keys(SCOPE_RESOLVERS);
}

/**
 * Map of runtime to valid scopes
 */
export const VALID_SCOPES: Record<string, string[]> = {
  'agent-skill': ['user', 'project'],
};

/**
 * Validate scope for a given runtime and return the target location
 * @throws {CommandRefusalError} `USAGE_INVALID` for a runtime or scope the
 *   invocation names that does not exist; `NOT_IMPLEMENTED` for a scope the
 *   runtime lists and has no location for
 */
export function validateAndGetScopeLocation(
  runtime: string,
  scope: string
): string {
  // Validate scope for runtime
  const validScopes = ownEntry(VALID_SCOPES, runtime);
  if (!validScopes?.includes(scope)) {
    const available = validScopes?.join(', ') ?? 'none';
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `Invalid scope '${scope}' for runtime '${runtime}'.\n` +
        `Valid scopes: ${available}`
    );
  }

  // Get scope location
  const resolve = ownEntry(ownEntry(SCOPE_RESOLVERS, runtime), scope);
  if (!resolve) {
    throw new CommandRefusalError('NOT_IMPLEMENTED', `Scope '${scope}' not implemented for runtime '${runtime}'`);
  }

  return resolve();
}

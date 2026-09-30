/**
 * Scope locations and validation for agent installation
 */

import os from 'node:os';

import { safePath } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError } from './command-refusal.js';

/**
 * Map of runtime to scope locations
 */
export const SCOPE_LOCATIONS: Record<string, Record<string, string>> = {
  'agent-skill': {
    user: safePath.join(os.homedir(), '.claude', 'skills'),
    project: safePath.join(process.cwd(), '.claude', 'skills'),
  },
};

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
  const validScopes = VALID_SCOPES[runtime];
  if (!validScopes?.includes(scope)) {
    const available = validScopes?.join(', ') ?? 'none';
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `Invalid scope '${scope}' for runtime '${runtime}'.\n` +
        `Valid scopes: ${available}`
    );
  }

  // Get scope location
  const targetLocation = SCOPE_LOCATIONS[runtime]?.[scope];
  if (!targetLocation) {
    throw new CommandRefusalError('NOT_IMPLEMENTED', `Scope '${scope}' not implemented for runtime '${runtime}'`);
  }

  return targetLocation;
}

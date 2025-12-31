/**
 * Scope locations and validation for agent installation
 */

import os from 'node:os';
import path from 'node:path';

/**
 * Map of runtime to scope locations
 */
export const SCOPE_LOCATIONS: Record<string, Record<string, string>> = {
  'claude-skill': {
    user: path.join(os.homedir(), '.claude', 'skills'),
    project: path.join(process.cwd(), '.claude', 'skills'),
  },
};

/**
 * Map of runtime to valid scopes
 */
export const VALID_SCOPES: Record<string, string[]> = {
  'claude-skill': ['user', 'project'],
};

/**
 * Validate scope for a given runtime and return the target location
 * @throws Error if scope is invalid or not implemented
 */
export function validateAndGetScopeLocation(
  runtime: string,
  scope: string
): string {
  // Validate scope for runtime
  const validScopes = VALID_SCOPES[runtime];
  if (!validScopes?.includes(scope)) {
    const available = validScopes?.join(', ') ?? 'none';
    throw new Error(
      `Invalid scope '${scope}' for runtime '${runtime}'.\n` +
        `Valid scopes: ${available}`
    );
  }

  // Get scope location
  const targetLocation = SCOPE_LOCATIONS[runtime]?.[scope];
  if (!targetLocation) {
    throw new Error(`Scope '${scope}' not implemented for runtime '${runtime}'`);
  }

  return targetLocation;
}

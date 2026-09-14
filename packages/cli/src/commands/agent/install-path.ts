/**
 * The one place `vat agent install` / `vat agent uninstall` turn a positional
 * into a path they will `rm -rf`, symlink, or copy over.
 *
 * The sweep ran `vat agent uninstall ../../../victim --scope project` and
 * watched it remove an arbitrary sibling directory at exit 0 with a green
 * "✓ Uninstalled". The positional was joined straight into the scope root.
 * Both verbs now come through here, and a name that is not ONE entry under
 * the scope root — a traversal, a separator, `.`, `..`, a drive spelling —
 * is refused by name before any path exists to act on.
 *
 * By name ONLY — deliberately no realpath check on the entry. `--dev`
 * installs the entry AS a symlink to the built skill outside the scope root,
 * so a check that resolved through the link read every live dev install as
 * "outside" and refused to uninstall or `--force`-replace it (a dangling one
 * passed, so the state most likely to be re-installed over was fine and the
 * state most likely to be uninstalled was not). The sink's question is "is the
 * ENTRY a direct child of the root": `rm` on a symlink removes the link and
 * never its target, and a single segment joined onto the root cannot name
 * anything else.
 */

import { isSingleFsSegment, safePath, VatError } from '@vibe-agent-toolkit/utils';

/** Thrown when the positional cannot name an entry directly under the scope root. */
export class AgentNameEscapesScopeError extends VatError {
  constructor(agentName: string, targetLocation: string) {
    super(
      'AGENT_NAME_ESCAPES_SCOPE',
      `Refusing to touch "${agentName}": an agent name must be a single path segment ` +
        `directly under ${targetLocation} (no separators, not "." or "..").`,
    );
  }
}

/**
 * Where `agentName` lives (or would live) under `targetLocation`.
 *
 * @param targetLocation - The scope root the verb was given
 * @param agentName - The positional exactly as typed
 * @returns The forward-slashed install path, a direct child of the root
 * @throws {AgentNameEscapesScopeError} When the name is not one segment
 */
export function agentInstallPath(targetLocation: string, agentName: string): string {
  if (!isSingleFsSegment(agentName)) {
    throw new AgentNameEscapesScopeError(agentName, targetLocation);
  }
  return safePath.join(targetLocation, agentName);
}

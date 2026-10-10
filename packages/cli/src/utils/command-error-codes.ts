/**
 * Error codes thrown by CLI command modules and mapped by `command-refusal.ts`.
 *
 * They live here, not beside their error classes, so the refusal map (a
 * utility every command loads) never imports a command module to learn a
 * string.
 */

/** The code an `AgentNameEscapesScopeError` carries — the invocation's mistake (`USAGE_INVALID`). */
export const AGENT_NAME_ESCAPES_SCOPE_CODE = 'AGENT_NAME_ESCAPES_SCOPE';

/** The code a `PluginSymlinkRefusedError` carries — the input's link (`INPUT_UNREADABLE`). */
export const PLUGIN_SYMLINK_REFUSED_CODE = 'PLUGIN_SYMLINK_REFUSED';

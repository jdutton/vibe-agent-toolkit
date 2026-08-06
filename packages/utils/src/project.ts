/**
 * @vibe-agent-toolkit/utils/project
 *
 * Project-root discovery: `findProjectRoot` (config-anchored, then
 * git-anchored) plus the narrower `findConfigFile` / `findNodeWorkspaceRoot`
 * probes and the cache reset used by long-lived processes.
 *
 * Node-only (walks the filesystem via `node:fs`), but dependency-free: this
 * entry resolves with zero third-party packages installed.
 */

export * from './project-utils.js';

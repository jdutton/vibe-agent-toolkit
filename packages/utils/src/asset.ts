/**
 * @vibe-agent-toolkit/utils/asset
 *
 * Asset reference resolution: accepts both filesystem paths (relative to a
 * base directory, or absolute) and npm bare specifiers (`@scope/pkg/subpath`),
 * honoring the target package's `exports` map. Node-only.
 */

export * from './asset-reference.js';

/**
 * Canonical list of packages for publishing
 *
 * This file is the single source of truth for which packages exist in the monorepo
 * and which should be published to npm.
 *
 * IMPORTANT: When adding new packages to packages/, you MUST update this file:
 * - Add to PUBLISHED_PACKAGES if it should be published to npm
 * - Add to SKIP_PACKAGES if it should NOT be published (e.g., private dev tools)
 *
 * Both pre-publish-check.ts and publish-with-rollback.ts import from this file
 * to ensure they stay in sync.
 */

/**
 * Packages to publish to npm, in dependency order
 *
 * Dependencies must come before dependents in this array.
 * The last package (umbrella) depends on all others.
 */
export const PUBLISHED_PACKAGES = [
  'agent-schema',
  'utils',
  'discovery',
  'resources',
  'resource-compiler',
  'rag',
  'rag-lancedb',
  'agent-config',
  'agent-runtime',
  'runtime-claude-agent-sdk',
  'agent-skills',
  'runtime-langchain',
  'runtime-openai',
  'runtime-vercel-ai-sdk',
  'transports',
  'cli',
  'gateway-mcp',
  'vat-development-agents',
  'vat-example-cat-agents',
  'vibe-agent-toolkit', // Umbrella package
] as const;

/**
 * Packages to skip (not published to npm)
 *
 * These packages exist in packages/ but should not be published.
 * Examples: private dev tools, test fixtures, examples not meant for distribution.
 */
export const SKIP_PACKAGES = [
  'dev-tools', // Private development tools package
  'test-agents', // Private test utilities for runtime adapters
] as const;

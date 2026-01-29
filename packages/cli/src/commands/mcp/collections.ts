/**
 * MCP collection resolution and loading
 *
 * Supports:
 * - Package names: @vibe-agent-toolkit/vat-example-cat-agents
 * - File paths: ./packages/vat-example-cat-agents
 * - Collection suffix: @scope/package:collection-name
 *
 * Phase 1: Dynamic loading from npm packages or file paths
 * Phase 2+: Global discovery registry
 */

import { pathToFileURL } from 'node:url';

import type { Agent, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';

export interface AgentRegistration {
  name: string;
  agent: Agent<unknown, OneShotAgentOutput<unknown, string>>;
  description: string;
}

export interface AgentCollection {
  name: string;
  description: string;
  agents: AgentRegistration[];
}

export interface CollectionModule {
  collections?: Record<string, AgentCollection>;
  defaultCollection?: AgentCollection;
  catAgents?: AgentCollection; // Legacy support
}

/**
 * Resolve package name or file path to a collection
 *
 * Supports:
 * - @scope/package → import from node_modules
 * - @scope/package:collection → import specific collection
 * - ./path → import from file path
 * - /abs/path → import from absolute path
 */
export async function resolveCollection(packageOrPath: string): Promise<AgentCollection> {
  const parts = packageOrPath.split(':');
  const packagePart = parts[0] ?? packageOrPath;
  const collectionName = parts[1];

  const importPath = buildImportPath(packagePart);
  const module = await loadCollectionModule(importPath, packageOrPath);

  return selectCollection(module, collectionName, packagePart, packageOrPath);
}

/**
 * Build import path from package name or file path
 */
function buildImportPath(packagePart: string): string {
  const isFilePath = packagePart.startsWith('.') || packagePart.startsWith('/');

  if (isFilePath) {
    // File path: convert to file:// URL for ESM import
    const absolutePath = new URL(packagePart, pathToFileURL(process.cwd() + '/').href).href;
    return `${absolutePath}/dist/mcp-collections.js`;
  }

  // Package name: import from node_modules
  return `${packagePart}/mcp-collections`;
}

/**
 * Load collection module with error handling
 */
async function loadCollectionModule(
  importPath: string,
  originalInput: string
): Promise<CollectionModule> {
  try {
    return (await import(importPath)) as CollectionModule;
  } catch (error) {
    throw new Error(
      `Failed to load MCP collections from '${originalInput}':\n` +
        `  Import path: ${importPath}\n` +
        `  Error: ${error instanceof Error ? error.message : String(error)}\n\n` +
        `Make sure the package:\n` +
        `  1. Is installed (npm/bun install)\n` +
        `  2. Exports 'mcp-collections' entrypoint\n` +
        `  3. Has been built (bun run build)`
    );
  }
}

/**
 * Select collection from module
 */
function selectCollection(
  module: CollectionModule,
  collectionName: string | undefined,
  packagePart: string,
  originalInput: string
): AgentCollection {
  // Explicit collection requested
  if (collectionName) {
    return selectExplicitCollection(module, collectionName, packagePart);
  }

  // Auto-select collection
  if (module.defaultCollection) {
    return module.defaultCollection;
  }

  if (module.catAgents) {
    return module.catAgents; // Legacy support
  }

  if (module.collections) {
    return selectFromCollections(module.collections, packagePart);
  }

  throw new Error(
    `No MCP collections found in '${originalInput}'.\n` +
      `Package must export:\n` +
      `  - collections: Record<string, MCPCollection>\n` +
      `  - defaultCollection: MCPCollection (optional)\n\n` +
      `See: packages/vat-example-cat-agents/src/mcp-collections.ts`
  );
}

/**
 * Select explicit collection by name
 */
function selectExplicitCollection(
  module: CollectionModule,
  collectionName: string,
  packagePart: string
): AgentCollection {
  const collection = module.collections?.[collectionName];
  if (!collection) {
    const available = module.collections ? Object.keys(module.collections).join(', ') : 'none';
    throw new Error(
      `Collection '${collectionName}' not found in '${packagePart}'.\n` +
        `Available collections: ${available}\n\n` +
        `Usage: ${packagePart}:${available.split(', ')[0] ?? collectionName}`
    );
  }
  return collection;
}

/**
 * Select collection from collections map
 */
function selectFromCollections(
  collections: Record<string, AgentCollection>,
  packagePart: string
): AgentCollection {
  const collectionNames = Object.keys(collections);

  if (collectionNames.length === 1) {
    const firstKey = collectionNames[0];
    const collection = firstKey ? collections[firstKey] : undefined;
    if (collection) {
      return collection;
    }
  }

  if (collectionNames.length > 1) {
    throw new Error(
      `Package '${packagePart}' exports multiple collections.\n` +
        `Please specify which one to use:\n` +
        collectionNames.map((name) => `  ${packagePart}:${name}`).join('\n')
    );
  }

  throw new Error(`No collections found in collections object`);
}

/**
 * List known packages with MCP collections
 *
 * Phase 1: Hardcoded known packages
 * Phase 2+: Global registry or package.json discovery
 */
export function listKnownPackages(): Array<{ name: string; description: string }> {
  return [
    {
      name: '@vibe-agent-toolkit/vat-example-cat-agents',
      description: 'Example cat breeding agents (haiku validator, photo analyzer)',
    },
  ];
}

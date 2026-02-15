import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Plugin source - can be local path, URL, or GitHub repo
 *
 * @see Claude Code source for supported source types
 */
const PluginSourceSchema = z.union([
  z.string().describe('Local path to plugin'),
  z.object({
    source: z.literal('url'),
    url: z.string().url().describe('Git repository URL'),
    ref: z.string().optional().describe('Git ref (branch, tag, commit)'),
    sha: z.string().optional().describe('Git commit SHA for pinning'),
  }).describe('External git repository (URL)'),
  z.object({
    source: z.literal('github'),
    repo: z.string().describe('GitHub owner/repo'),
    ref: z.string().optional().describe('Git ref (branch, tag, commit)'),
    sha: z.string().optional().describe('Git commit SHA for pinning'),
  }).describe('GitHub repository'),
]);

/**
 * LSP server configuration
 * @see https://code.claude.com/docs/en/plugins-reference
 */
const LspServerConfigSchema = z.object({
  command: z.string().describe('Command to start the LSP server'),
  extensionToLanguage: z.record(z.string()).describe('File extension to language ID mapping (required)'),
  args: z.array(z.string()).optional().describe('Command-line arguments'),
  transport: z.enum(['stdio', 'socket']).optional().describe('Transport protocol (default: stdio)'),
  env: z.record(z.string()).optional().describe('Environment variables'),
  initializationOptions: z.record(z.unknown()).optional().describe('LSP initialization options'),
  settings: z.record(z.unknown()).optional().describe('LSP server settings'),
  workspaceFolder: z.string().optional().describe('Workspace folder path'),
  startupTimeout: z.number().optional().describe('Timeout in milliseconds for server startup'),
  shutdownTimeout: z.number().optional().describe('Timeout in milliseconds for server shutdown'),
  restartOnCrash: z.boolean().optional().describe('Auto-restart on crash'),
  maxRestarts: z.number().optional().describe('Maximum restart attempts'),
}).passthrough().describe('LSP server configuration');

/**
 * Plugin entry in marketplace manifest
 * Supports: bundled skills, external repos, LSP servers
 *
 * Uses passthrough to accept additional fields from the official spec
 * that may not yet be modeled here.
 */
const MarketplacePluginSchema = z.object({
  name: z.string()
    .min(1)
    .describe('Plugin name'),

  description: z.string().optional()
    .describe('Plugin description'),

  source: PluginSourceSchema,

  version: z.string().optional()
    .describe('Plugin version (for external repos)'),

  strict: z.boolean().optional()
    .describe('Enable strict validation mode'),

  skills: z.array(z.string()).optional()
    .describe('Array of skill paths (for bundled skills)'),

  lspServers: z.record(LspServerConfigSchema).optional()
    .describe('LSP server configurations'),

  author: z.object({
    name: z.string(),
    email: z.string().email().optional(),
  }).optional().describe('Plugin author'),

  category: z.string().optional()
    .describe('Plugin category'),

  homepage: z.string().url().optional()
    .describe('Plugin homepage URL'),

  tags: z.array(z.string()).optional()
    .describe('Plugin tags'),

  repository: z.string().url().optional()
    .describe('Source repository URL'),

  license: z.string().optional()
    .describe('License identifier'),

  keywords: z.array(z.string()).optional()
    .describe('Search keywords'),

  commands: z.union([z.string(), z.array(z.string())]).optional()
    .describe('Command paths'),

  agents: z.union([z.string(), z.array(z.string())]).optional()
    .describe('Agent paths'),

  hooks: z.union([z.string(), z.array(z.string()), z.record(z.unknown())]).optional()
    .describe('Hook config'),

  mcpServers: z.union([z.string(), z.array(z.string()), z.record(z.unknown())]).optional()
    .describe('MCP server config'),
}).passthrough().describe('Plugin entry in marketplace manifest');

/**
 * Schema for marketplace.json manifest
 *
 * Note: No official JSON Schema URL exists yet. This Zod schema is derived
 * from observed real-world marketplace.json files and Claude Code source,
 * and should be kept in sync via tests.
 *
 * Uses passthrough at all levels to accept fields from the official spec
 * that may not yet be modeled here.
 */
export const MarketplaceSchema = z.object({
  $schema: z.string().url().optional()
    .describe('JSON Schema reference'),

  name: z.string()
    .min(1)
    .describe('Marketplace name'),

  description: z.string().optional()
    .describe('Marketplace description'),

  owner: z.object({
    name: z.string(),
    email: z.string().email().optional(),
  }).passthrough().describe('Marketplace owner'),

  metadata: z.object({
    description: z.string(),
    version: z.string(),
    pluginRoot: z.string().optional().describe('Root directory for plugin paths'),
  }).passthrough().optional().describe('Marketplace metadata'),

  plugins: z.array(MarketplacePluginSchema)
    .describe('Array of plugin configurations'),
}).passthrough().describe('Marketplace manifest structure');

export type Marketplace = z.infer<typeof MarketplaceSchema>;
export type MarketplacePlugin = z.infer<typeof MarketplacePluginSchema>;
export type PluginSource = z.infer<typeof PluginSourceSchema>;
export type LspServerConfig = z.infer<typeof LspServerConfigSchema>;

/**
 * JSON Schema representation of Marketplace schema
 * Generated from Zod schema for external tooling
 */
export const MarketplaceJsonSchema = zodToJsonSchema(MarketplaceSchema, {
  name: 'MarketplaceManifest',
  $refStrategy: 'none',
});

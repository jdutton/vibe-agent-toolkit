import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Plugin source - can be local path or external git repo
 */
const PluginSourceSchema = z.union([
  z.string().describe('Local path to plugin'),
  z.object({
    source: z.literal('url'),
    url: z.string().url().describe('Git repository URL'),
  }).describe('External git repository'),
]);

/**
 * LSP server configuration
 */
const LspServerConfigSchema = z.object({
  command: z.string().describe('Command to start the LSP server'),
  args: z.array(z.string()).optional().describe('Command-line arguments'),
  extensionToLanguage: z.record(z.string()).optional().describe('File extension to language ID mapping'),
  startupTimeout: z.number().optional().describe('Timeout in milliseconds for server startup'),
}).strict().describe('LSP server configuration');

/**
 * Plugin entry in marketplace manifest
 * Supports: bundled skills, external repos, LSP servers
 */
const MarketplacePluginSchema = z.object({
  name: z.string()
    .min(1)
    .describe('Plugin name'),

  description: z.string()
    .min(1)
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
}).strict().describe('Plugin entry in marketplace manifest');

/**
 * Schema for marketplace.json manifest
 * Based on external schema: https://anthropic.com/claude-code/marketplace.schema.json
 *
 * Note: External schema is AUTHORITATIVE but not currently available.
 * This Zod schema is derived from observed real-world marketplace.json files
 * and should be kept in sync via tests.
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
  }).strict().describe('Marketplace owner'),

  metadata: z.object({
    description: z.string(),
    version: z.string(),
  }).strict().optional().describe('Marketplace metadata'),

  plugins: z.array(MarketplacePluginSchema)
    .describe('Array of plugin configurations'),
}).strict().describe('Marketplace manifest structure');

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

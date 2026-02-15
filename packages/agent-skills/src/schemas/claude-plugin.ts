import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Schema for .claude-plugin/plugin.json manifest
 * Based on official Claude Code documentation
 * @see https://code.claude.com/docs/en/plugins-reference
 */

/**
 * Component path schemas per official Claude Code plugin spec.
 * @see https://code.claude.com/docs/en/plugins-reference#component-path-fields
 *
 * Path-only fields (commands, agents, skills, outputStyles): string | string[]
 * Config-capable fields (hooks, mcpServers, lspServers): string | string[] | object
 */
const ComponentPathsSchema = z.union([
  z.string(),
  z.array(z.string()),
]);

const ComponentPathsOrConfigSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.record(z.unknown()),
]);

export const ClaudePluginSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Plugin name is required')
      .max(64, 'Plugin name must be 64 characters or less')
      .regex(
        /^[a-z0-9]+(-[a-z0-9]+)*$/, // eslint-disable-line security/detect-unsafe-regex -- Simple pattern with bounded length, safe from ReDoS
        'Plugin name must be lowercase alphanumeric with hyphens'
      )
      .describe('Unique plugin identifier (required if manifest exists)'),

    version: z
      .string()
      .regex(
        /^\d+\.\d+\.\d+$/,
        'Version must follow semver format (e.g., 1.0.0)'
      )
      .optional()
      .describe('Semantic version (optional)'),

    description: z
      .string()
      .min(1)
      .max(1024, 'Description must be 1024 characters or less')
      .optional()
      .describe('Human-readable description of plugin functionality (optional)'),

    author: z
      .object({
        name: z.string().optional(),
        email: z.string().email().optional(),
        url: z.string().url().optional(),
      })
      .optional()
      .describe('Plugin author information'),

    homepage: z.string().url().optional().describe('Plugin homepage URL'),
    repository: z.string().url().optional().describe('Source repository URL'),
    license: z.string().optional().describe('License identifier (e.g., MIT)'),
    keywords: z
      .array(z.string())
      .optional()
      .describe('Search keywords for plugin discovery'),

    // Component paths (all optional) — per official spec, string | string[] or string | string[] | object
    commands: ComponentPathsSchema.optional().describe('Command files or directories'),
    skills: ComponentPathsSchema.optional().describe('Skill directories'),
    agents: ComponentPathsSchema.optional().describe('Agent files or directories'),
    hooks: ComponentPathsOrConfigSchema.optional().describe('Hook config path(s) or inline config'),
    mcpServers: ComponentPathsOrConfigSchema.optional().describe('MCP server config path(s) or inline config'),
    outputStyles: ComponentPathsSchema.optional().describe('Output style files or directories'),
    lspServers: ComponentPathsOrConfigSchema.optional().describe('LSP server config path(s) or inline config'),
  })
  .passthrough() // Accept unknown fields — official spec evolves
  .describe('Claude Code plugin manifest structure');

export type ClaudePlugin = z.infer<typeof ClaudePluginSchema>;

/**
 * JSON Schema representation of ClaudePluginSchema
 * For external tools and documentation
 */
export const ClaudePluginJsonSchema = zodToJsonSchema(ClaudePluginSchema, {
  name: 'ClaudePluginManifest',
  $refStrategy: 'none',
});

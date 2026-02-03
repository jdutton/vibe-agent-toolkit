import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Schema for plugin.json manifest
 * Community-derived (no official schema from Anthropic)
 * Based on observed examples from real plugin installations
 */
export const PluginSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Plugin name is required')
      .max(64, 'Plugin name must be 64 characters or less')
      .regex(
        /^[a-z0-9]+(-[a-z0-9]+)*$/, // eslint-disable-line security/detect-unsafe-regex -- Simple pattern with bounded length, safe from ReDoS
        'Plugin name must be lowercase alphanumeric with hyphens'
      )
      .describe('Unique plugin identifier'),

    description: z
      .string()
      .min(1, 'Description is required')
      .max(1024, 'Description must be 1024 characters or less')
      .describe('Human-readable description of plugin functionality'),

    version: z
      .string()
      .regex(
        /^\d+\.\d+\.\d+$/,
        'Version must follow semver format (e.g., 1.0.0)'
      )
      .describe('Semantic version'),

    author: z
      .object({
        name: z.string().optional(),
        email: z.string().email().optional(),
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
  })
  .strict()
  .describe('Plugin manifest structure');

export type Plugin = z.infer<typeof PluginSchema>;

/**
 * JSON Schema representation of PluginSchema
 * For external tools and documentation
 */
export const PluginJsonSchema = zodToJsonSchema(PluginSchema, {
  name: 'PluginManifest',
  $refStrategy: 'none',
});

import { z } from 'zod';

/**
 * Strict schema for plugin.json — matches Anthropic's official format exactly.
 *
 * Only name, description, author, and optionally version are allowed.
 * No additional fields. This ensures installed plugins are indistinguishable
 * from Anthropic official plugins.
 */
export const PluginJsonSchema = z.object({
  name: z.string().min(1).describe('Plugin name'),
  description: z.string().min(1).describe('Plugin description'),
  author: z.object({
    name: z.string().min(1).describe('Author name'),
    email: z.string().optional().describe('Author email'),
  }).strict().describe('Plugin author'),
  version: z.string().optional().describe('Plugin version'),
}).strict().describe('Claude plugin.json (strict — must match Anthropic official format)');

export type PluginJson = z.infer<typeof PluginJsonSchema>;

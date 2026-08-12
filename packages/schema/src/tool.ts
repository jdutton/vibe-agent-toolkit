import { z } from 'zod';

/**
 * Base tool configuration (shared by both primary and alternative tools)
 */
const BaseToolConfigSchema = z.object({
  type: z.enum(['mcp', 'library', 'builtin'])
    .describe('Tool type'),

  server: z.string()
    .optional()
    .describe('MCP server name (for type=mcp)'),

  package: z.string()
    .optional()
    .describe('Library package name (for type=library)'),

  function: z.string()
    .optional()
    .describe('Function to call (for type=library)'),

  llmMapping: z.record(z.string())
    .optional()
    .describe('LLM-specific tool names (for type=builtin)'),
}).strict();

/**
 * Tool alternative (different implementation)
 */
export const ToolAlternativeSchema = BaseToolConfigSchema.describe('Alternative tool implementation');

export type ToolAlternative = z.infer<typeof ToolAlternativeSchema>;

/**
 * Tool definition
 */
export const ToolSchema = BaseToolConfigSchema.extend({
  name: z.string()
    .describe('Tool identifier'),

  description: z.string()
    .optional()
    .describe('Human-readable tool description'),

  alternatives: z.array(ToolAlternativeSchema)
    .optional()
    .describe('Alternative tool implementations'),
}).strict().describe('Tool definition');

export type Tool = z.infer<typeof ToolSchema>;

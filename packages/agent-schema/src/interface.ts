import { z } from 'zod';

/**
 * Schema reference (JSON Schema $ref)
 */
export const SchemaRefSchema = z.object({
  $ref: z.string()
    .describe('Path to JSON Schema file (relative or absolute)'),
}).strict().describe('JSON Schema reference');

export type SchemaRef = z.infer<typeof SchemaRefSchema>;

/**
 * Agent interface (input/output schemas)
 */
export const AgentInterfaceSchema = z.object({
  input: SchemaRefSchema
    .optional()
    .describe('Input schema (what data agent accepts)'),

  output: SchemaRefSchema
    .optional()
    .describe('Output schema (what data agent produces)'),
}).strict().describe('Agent input/output interface');

export type AgentInterface = z.infer<typeof AgentInterfaceSchema>;

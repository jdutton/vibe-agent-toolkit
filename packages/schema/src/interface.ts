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

/**
 * TypeScript interface for executable agents.
 *
 * Represents a VAT agent with a defined input/output contract and manifest.
 * ALL agents must be async for consistency and future capabilities.
 */
export interface Agent<TInput = unknown, TOutput = unknown> {
  /** Unique name for the agent */
  name: string;

  /** Metadata describing the agent's interface and capabilities */
  manifest: AgentManifest;

  /**
   * Execute the agent with given input.
   * ALL agents must return Promise for consistency and future-proofing.
   */
  execute(input: TInput, context?: unknown): Promise<TOutput>;
}

/**
 * Agent manifest metadata.
 * Describes what the agent does and how to interact with it.
 */
export interface AgentManifest {
  /** Unique name for the agent */
  name: string;

  /** Semantic version (e.g., "1.0.0") */
  version: string;

  /** Human-readable description of what the agent does */
  description: string;

  /** Agent archetype (e.g., "pure-function-tool", "llm-analyzer", "conversational-assistant") */
  archetype: string;

  /** Additional metadata (model, temperature, capabilities, etc.) */
  metadata?: Record<string, unknown>;
}

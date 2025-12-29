import { z } from 'zod';

import { AgentInterfaceSchema } from './interface.js';
import { LLMConfigSchema } from './llm.js';
import { AgentMetadataSchema } from './metadata.js';
import { ResourceRegistrySchema } from './resource-registry.js';
import { ToolSchema } from './tool.js';

/**
 * Prompt configuration
 */
export const PromptConfigSchema = z.object({
  $ref: z.string()
    .describe('Reference to resource in ResourceRegistry'),

  variables: z.array(z.string())
    .optional()
    .describe('Template variables required by this prompt'),
}).strict().describe('Prompt configuration');

export type PromptConfig = z.infer<typeof PromptConfigSchema>;

/**
 * Prompts configuration
 */
export const PromptsConfigSchema = z.object({
  system: PromptConfigSchema
    .optional()
    .describe('System prompt'),

  user: PromptConfigSchema
    .optional()
    .describe('User prompt template'),
}).strict().describe('Agent prompts');

export type PromptsConfig = z.infer<typeof PromptsConfigSchema>;

/**
 * Memory configuration (simplified for Phase 1)
 */
export const MemoryConfigSchema = z.object({
  shortTerm: z.object({
    type: z.string(),
    maxMessages: z.number().optional(),
  }).passthrough().optional(),

  longTerm: z.object({
    type: z.string(),
    store: z.any().optional(),
  }).passthrough().optional(),
}).passthrough().describe('Memory configuration (details TBD in Phase 2)');

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

/**
 * RAG configuration (simplified for Phase 1)
 */
export const RAGConfigSchema = z.record(
  z.object({
    sources: z.any(),
    chunking: z.any().optional(),
    embedding: z.any().optional(),
    retrieval: z.any().optional(),
  }).passthrough()
).describe('RAG configuration (details TBD in Phase 2)');

export type RAGConfig = z.infer<typeof RAGConfigSchema>;

/**
 * Composition configuration (simplified for Phase 1)
 */
export const CompositionConfigSchema = z.object({
  subAgents: z.array(
    z.object({
      agent: z.string().describe('Agent package name'),
      version: z.string().optional().describe('Agent version requirement'),
      role: z.string().describe('Role identifier'),
      description: z.string().optional(),
    }).passthrough()
  ).optional(),

  coordination: z.object({
    strategy: z.string().optional(),
    errorHandling: z.string().optional(),
  }).passthrough().optional(),
}).passthrough().describe('Multi-agent composition (details TBD in Phase 2)');

export type CompositionConfig = z.infer<typeof CompositionConfigSchema>;

/**
 * Credentials configuration
 */
export const CredentialsConfigSchema = z.object({
  agent: z.array(
    z.object({
      name: z.string().describe('Credential name (e.g., env var name)'),
      description: z.string().optional(),
      required: z.boolean().optional(),
      source: z.enum(['env', 'vault', 'config']).optional(),
    }).strict()
  ).optional().describe('Agent-level credentials'),
}).strict().describe('Credentials configuration');

export type CredentialsConfig = z.infer<typeof CredentialsConfigSchema>;

/**
 * Agent specification
 */
export const AgentSpecSchema = z.object({
  interface: AgentInterfaceSchema
    .optional()
    .describe('Agent input/output interface'),

  llm: LLMConfigSchema
    .describe('LLM configuration (required)'),

  prompts: PromptsConfigSchema
    .optional()
    .describe('Agent prompts'),

  tools: z.array(ToolSchema)
    .optional()
    .describe('Tools available to agent'),

  memory: MemoryConfigSchema
    .optional()
    .describe('Memory configuration'),

  rag: RAGConfigSchema
    .optional()
    .describe('RAG configuration'),

  composition: CompositionConfigSchema
    .optional()
    .describe('Multi-agent composition'),

  resources: ResourceRegistrySchema
    .optional()
    .describe('Resource registry'),

  credentials: CredentialsConfigSchema
    .optional()
    .describe('Credentials requirements'),
}).strict().describe('Agent specification');

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/**
 * Test configuration (simplified)
 */
export const TestConfigSchema = z.object({
  goldenDatasets: z.array(
    z.object({
      path: z.string(),
    }).passthrough()
  ).optional(),

  evaluationMetrics: z.array(z.string()).optional(),
}).passthrough().describe('Test configuration');

export type TestConfig = z.infer<typeof TestConfigSchema>;

/**
 * Complete agent manifest
 */
export const AgentManifestSchema = z.object({
  apiVersion: z.literal('vat.dev/v1')
    .describe('VAT API version'),

  kind: z.literal('Agent')
    .describe('Manifest kind'),

  metadata: AgentMetadataSchema
    .describe('Agent metadata'),

  spec: AgentSpecSchema
    .describe('Agent specification'),

  tests: TestConfigSchema
    .optional()
    .describe('Test configuration'),
}).strict().describe('VAT Agent Manifest');

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

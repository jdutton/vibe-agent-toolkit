/**
 * @vibe-agent-toolkit/agent-schema
 *
 * JSON Schema definitions and TypeScript types for VAT agent manifest format.
 */

// JSON Schema utilities
export { toJsonSchema, type JsonSchemaOptions } from './schema-utils.js';

// Result types
export * from './result-types.js';
export * from './output-envelopes.js';

// Core schemas
export {
  AgentMetadataSchema,
  BuildMetadataSchema,
  type AgentMetadata,
  type BuildMetadata,
} from './metadata.js';

export {
  LLMConfigSchema,
  type LLMConfig,
} from './llm.js';

export {
  AgentInterfaceSchema,
  SchemaRefSchema,
  type Agent,
  type AgentInterface,
  type SchemaRef,
} from './interface.js';

export {
  ToolAlternativeSchema,
  ToolSchema,
  type Tool,
  type ToolAlternative,
} from './tool.js';

export {
  ResourceRegistrySchema,
  ResourceSchema,
  type Resource,
  type ResourceRegistry,
} from './resource-registry.js';

export {
  AgentManifestSchema,
  AgentSpecSchema,
  CompositionConfigSchema,
  CredentialsConfigSchema,
  MemoryConfigSchema,
  PromptConfigSchema,
  PromptsConfigSchema,
  RAGConfigSchema,
  TestConfigSchema,
  type AgentManifest,
  type AgentSpec,
  type CompositionConfig,
  type CredentialsConfig,
  type MemoryConfig,
  type PromptConfig,
  type PromptsConfig,
  type RAGConfig,
  type TestConfig,
} from './agent-manifest.js';

export {
  VatAgentMetadataSchema,
  VatPackageMetadataSchema,
  VatPureFunctionMetadataSchema,
  VatSkillMetadataSchema,
  type VatAgentMetadata,
  type VatPackageMetadata,
  type VatPureFunctionMetadata,
  type VatSkillMetadata,
} from './package-metadata.js';

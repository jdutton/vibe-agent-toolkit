/**
 * Agent manifest loading and validation
 * @packageDocumentation
 */

// Re-export types from schema for convenience
export type {
  AgentManifest,
  AgentMetadata,
  AgentSpec,
  LLMConfig,
  Tool,
} from '@vibe-agent-toolkit/schema';

// Loader
export {
  AGENT_MANIFEST_INVALID_CODE,
  AGENT_MANIFEST_NOT_FOUND_CODE,
  AGENT_MANIFEST_UNREADABLE_CODE,
  findManifestPath,
  loadAgentManifest,
  type LoadedAgentManifest,
} from './loader/manifest-loader.js';

// Validator
export {
  validateAgent,
  type ValidateAgentOptions,
  type ValidationResult,
} from './validator/agent-validator.js';

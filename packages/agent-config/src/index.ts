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
  findManifestPath,
  loadAgentManifest,
  type LoadedAgentManifest,
} from './loader/manifest-loader.js';

// Validator
export {
  validateAgent,
  type ValidationResult,
} from './validator/agent-validator.js';

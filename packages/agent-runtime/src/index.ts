/**
 * VAT Agent Runtime Framework
 *
 * Provides APIs for defining portable, executable agents with validated
 * input/output contracts and manifest generation.
 */

export { definePureFunction, type PureFunctionConfig } from './pure-function.js';
export { defineLLMAnalyzer, type LLMAnalyzerConfig } from './llm-analyzer.js';
export {
  defineConversationalAssistant,
  type ConversationalAssistantConfig,
} from './conversational-assistant.js';
export {
  defineTwoPhaseConversationalAssistant,
  generateGatheringPrompt,
  generateExtractionPrompt,
  type TwoPhaseConversationalConfig,
  type GatheringPhaseConfig,
  type ExtractionPhaseConfig,
  type FactorDefinition,
} from './two-phase-conversational.js';
export {
  defineAgenticResearcher,
  type AgenticResearcherConfig,
} from './agentic-researcher.js';
export {
  defineFunctionOrchestrator,
  type FunctionOrchestratorConfig,
} from './function-orchestrator.js';
export { defineLLMCoordinator, type LLMCoordinatorConfig } from './llm-coordinator.js';
export {
  defineFunctionEventConsumer,
  type FunctionEventConsumerConfig,
} from './function-event-consumer.js';
export {
  defineLLMEventHandler,
  type LLMEventHandlerConfig,
} from './llm-event-handler.js';
export {
  defineExternalEventIntegrator,
  type ExternalEventIntegratorConfig,
} from './external-event-integrator.js';

export type {
  Agent,
  AgentManifest,
  ConversationalContext,
  CoordinatorContext,
  EventConsumerContext,
  ExternalEventContext,
  LLMAnalyzerContext,
  LLMEventHandlerContext,
  Message,
  OrchestratorContext,
  PureFunctionAgent,
  ResearcherContext,
  RetryOptions,
} from './types.js';

export {
  batchConvert,
  type LLMAnalyzerConversionConfig,
  type LLMAnalyzerConversionConfigs,
  type ToolConversionConfig,
  type ToolConversionConfigs,
} from './adapter-types.js';

export { createConversationalContext } from './conversational-helpers.js';

// Session management
export type {
  Message as SessionMessage,
  RuntimeSession,
  SessionMetadata,
  SessionStore,
  SessionStoreOptions,
  FileSessionStoreOptions,
} from './session/index.js';
export {
  SessionNotFoundError,
  MemorySessionStore,
  FileSessionStore,
  createInitialSession,
  isSessionExpired,
  updateSessionAccess,
  validateSessionId,
} from './session/index.js';

export { andThen, mapResult, match, unwrap, withRetry, withTiming } from './result-helpers.js';
export {
  executeExternalEvent,
  executeLLMAnalyzer,
  executeLLMCall,
  validateAgentInput,
} from './agent-helpers.js';

// Re-export result constructors and constants from agent-schema for convenience
// This allows users to import everything they need from agent-runtime
export {
  createSuccess,
  createError,
  createInProgress,
  RESULT_SUCCESS,
  RESULT_ERROR,
  RESULT_IN_PROGRESS,
  LLM_REFUSAL,
  LLM_INVALID_OUTPUT,
  LLM_TIMEOUT,
  LLM_RATE_LIMIT,
  LLM_TOKEN_LIMIT,
  LLM_UNAVAILABLE,
  EVENT_TIMEOUT,
  EVENT_UNAVAILABLE,
  EVENT_REJECTED,
  EVENT_INVALID_RESPONSE,
  type AgentResult,
  type StatefulAgentResult,
  type ExecutionMetadata,
  type LLMError,
  type ExternalEventError,
} from '@vibe-agent-toolkit/agent-schema';

// NOTE: resultMatchers is NOT exported from main index to avoid importing vitest
// in production code. Import directly from './test-helpers.js' in test files.

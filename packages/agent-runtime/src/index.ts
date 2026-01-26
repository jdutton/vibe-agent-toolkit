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

export { andThen, mapResult, match, unwrap } from './result-helpers.js';
export {
  createPureFunctionAgent,
  createSafePureFunctionAgent,
  executeExternalEvent,
  executeLLMAnalyzer,
  executeLLMCall,
  validateAgentInput,
} from './agent-helpers.js';

// NOTE: resultMatchers is NOT exported from main index to avoid importing vitest
// in production code. Import directly from './test-helpers.js' in test files.

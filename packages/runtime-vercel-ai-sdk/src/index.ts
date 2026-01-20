/**
 * @vibe-agent-toolkit/runtime-vercel-ai-sdk
 *
 * Vercel AI SDK runtime adapter for VAT (Vibe Agent Toolkit) agents.
 *
 * Converts VAT archetype agents to Vercel AI SDK primitives:
 * - PureFunctionAgent → tool() for structured data operations
 * - LLMAnalyzerAgent → generateText() for AI-powered analysis
 *
 * Supports OpenAI, Anthropic, and other providers via Vercel AI SDK.
 */

// Adapters
export {
  convertPureFunctionToTool,
  convertPureFunctionsToTools,
  type ToolConversionConfig,
} from './adapters/pure-function.js';

export {
  convertLLMAnalyzerToFunction,
  convertLLMAnalyzersToFunctions,
  type LLMAnalyzerConversionConfig,
} from './adapters/llm-analyzer.js';

// Types
export type {
  VercelAITool,
  VercelAILLMConfig,
  ConversionResult,
} from './types.js';

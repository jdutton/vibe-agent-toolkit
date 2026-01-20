import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * LangChain LLM configuration for VAT agents
 */
export interface LangChainLLMConfig {
  /**
   * LangChain chat model instance (e.g., ChatOpenAI, ChatAnthropic)
   */
  model: BaseChatModel;

  /**
   * Temperature for text generation (0-1)
   * Higher values make output more random, lower values more deterministic
   */
  temperature?: number;

  /**
   * Maximum tokens to generate
   */
  maxTokens?: number;

  /**
   * Additional model-specific settings
   */
  additionalSettings?: Record<string, unknown>;
}

// Re-export adapter types from agent-runtime
export type {
  LLMAnalyzerConversionConfig,
  LLMAnalyzerConversionConfigs,
  ToolConversionConfig,
  ToolConversionConfigs,
} from '@vibe-agent-toolkit/agent-runtime';

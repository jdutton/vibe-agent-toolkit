import type OpenAI from 'openai';

/**
 * OpenAI configuration for VAT agents
 */
export interface OpenAIConfig {
  /**
   * OpenAI client instance
   */
  client: OpenAI;

  /**
   * Model to use (e.g., 'gpt-4o-mini', 'gpt-4o')
   */
  model: string;

  /**
   * Temperature for text generation (0-2)
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
  additionalSettings?: Omit<
    OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    'model' | 'messages' | 'temperature' | 'max_tokens'
  >;
}

// Re-export adapter types from agent-runtime
export type {
  LLMAnalyzerConversionConfig,
  LLMAnalyzerConversionConfigs,
  ToolConversionConfig,
  ToolConversionConfigs,
} from '@vibe-agent-toolkit/agent-runtime';

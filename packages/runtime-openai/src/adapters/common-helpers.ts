/**
 * Common helper functions for OpenAI runtime adapters
 */

import type { Message } from '@vibe-agent-toolkit/agent-runtime';

import type { OpenAIConfig } from '../types.js';

/**
 * Helper to extract text from OpenAI API response
 */
export function extractTextFromResponse(response: { choices: Array<{ message: { content: string | null } }> }): string {
  return response.choices[0]?.message.content ?? '';
}

/**
 * Helper to create OpenAI API parameters with optional fields
 */
function createBaseParams(
  model: string,
  temperature?: number,
  maxTokens?: number,
): {
  model: string;
  temperature?: number;
  max_tokens?: number;
} {
  const params: {
    model: string;
    temperature?: number;
    max_tokens?: number;
  } = { model };

  // Only add optional parameters if defined
  if (temperature !== undefined) {
    params.temperature = temperature;
  }
  if (maxTokens !== undefined) {
    params.max_tokens = maxTokens;
  }

  return params;
}

/**
 * Creates a callLLM function for LLM Analyzer agents
 *
 * @param openaiConfig - OpenAI configuration
 * @returns callLLM function for single-turn prompts
 */
export function createLLMAnalyzerCallLLM(openaiConfig: OpenAIConfig) {
  return async (prompt: string): Promise<string> => {
    const params = createBaseParams(
      openaiConfig.model,
      openaiConfig.temperature,
      openaiConfig.maxTokens,
    );

    const response = await openaiConfig.client.chat.completions.create({
      ...params,
      messages: [{ role: 'user', content: prompt }],
      ...openaiConfig.additionalSettings,
    });

    return extractTextFromResponse(response);
  };
}

/**
 * Creates a callLLM function for Conversational Assistant agents
 *
 * @param openaiConfig - OpenAI configuration
 * @returns callLLM function for multi-turn conversations
 */
export function createConversationalCallLLM(openaiConfig: OpenAIConfig) {
  return async (messages: Message[]): Promise<string> => {
    const params = createBaseParams(
      openaiConfig.model,
      openaiConfig.temperature,
      openaiConfig.maxTokens,
    );

    // Convert VAT messages to OpenAI format
    const openaiMessages = messages.map((m) => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    }));

    const response = await openaiConfig.client.chat.completions.create({
      ...params,
      messages: openaiMessages,
      ...openaiConfig.additionalSettings,
    });

    return extractTextFromResponse(response);
  };
}

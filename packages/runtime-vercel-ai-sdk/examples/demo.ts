/**
 * Vercel AI SDK Demo - uses common demo infrastructure
 *
 * Prerequisites:
 * - OPENAI_API_KEY environment variable
 * - ANTHROPIC_API_KEY environment variable (optional, for provider comparison)
 *
 * Run with: source ~/.secrets.env && bun run demo
 */

import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { generateText, stepCountIs } from 'ai';

import { convertLLMAnalyzerToFunction } from '../src/adapters/llm-analyzer.js';
import { convertPureFunctionToTool, convertPureFunctionsToTools } from '../src/adapters/pure-function.js';

import type { RuntimeAdapter } from './common-demo.js';
import { runCommonDemo } from './common-demo.js';

/**
 * Vercel AI SDK Runtime Adapter implementation
 */
const vercelAIAdapter: RuntimeAdapter = {
  name: 'Vercel AI SDK',

  convertPureFunctionToTool: convertPureFunctionToTool as unknown as RuntimeAdapter['convertPureFunctionToTool'],

  convertPureFunctionsToTools: convertPureFunctionsToTools as unknown as RuntimeAdapter['convertPureFunctionsToTools'],

  convertLLMAnalyzerToFunction: convertLLMAnalyzerToFunction as unknown as RuntimeAdapter['convertLLMAnalyzerToFunction'],

  createPrimaryLLMConfig: () => ({
    model: openai('gpt-4o-mini'),
    temperature: 0.9,
  }),

  createSecondaryLLMConfig: () => ({
    model: anthropic('claude-sonnet-4-5-20250929'),
    temperature: 0.9,
  }),

  demoToolCalling: async (toolWrapper: unknown, prompt: string) => {
    const { tool } = toolWrapper as { tool: ReturnType<typeof convertPureFunctionToTool>['tool'] };

    const result = await generateText({
      model: openai('gpt-4o-mini'),
      tools: {
        validateHaiku: tool,
      },
      stopWhen: stepCountIs(3),
      prompt,
    });

    return {
      text: result.text,
      toolCalls: result.toolCalls as unknown[],
      toolResults: result.toolResults as unknown[],
    };
  },
};

// Run the common demo with Vercel AI SDK adapter
runCommonDemo(vercelAIAdapter).catch(console.error);

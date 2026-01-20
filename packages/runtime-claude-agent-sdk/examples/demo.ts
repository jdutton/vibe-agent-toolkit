/**
 * Claude Agent SDK Demo - uses common demo infrastructure
 *
 * Prerequisites:
 * - ANTHROPIC_API_KEY environment variable (for Claude 3.5 Haiku)
 * - OPENAI_API_KEY environment variable (for GPT-4o-mini comparison)
 *
 * Run with: source ~/.secrets.env && bun run demo
 */

import type { Agent } from '@vibe-agent-toolkit/agent-runtime';
import OpenAI from 'openai';
import type { z } from 'zod';

import type { RuntimeAdapter } from '../../runtime-vercel-ai-sdk/examples/common-demo.js';
import { runCommonDemo } from '../../runtime-vercel-ai-sdk/examples/common-demo.js';
import { convertLLMAnalyzerToTool } from '../src/adapters/llm-analyzer.js';
import { convertPureFunctionToTool, convertPureFunctionsToTools } from '../src/adapters/pure-function.js';
import type { ClaudeAgentLLMConfig } from '../src/types.js';

/**
 * LLM config that supports both Anthropic and OpenAI
 */
interface DemoLLMConfig extends ClaudeAgentLLMConfig {
  provider?: 'anthropic' | 'openai';
}

/**
 * Wraps convertLLMAnalyzerToTool to return a function instead of a tool
 * Supports both Anthropic (via adapter) and OpenAI (direct integration)
 */
function convertLLMAnalyzerToFunction<TInput, TOutput>(
  agent: Agent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  llmConfig: DemoLLMConfig,
): (input: TInput) => Promise<TOutput> {
  const provider = llmConfig.provider ?? 'anthropic';

  if (provider === 'openai') {
    // Direct OpenAI integration for demo purposes
    const openai = new OpenAI({
      apiKey: llmConfig.apiKey ?? process.env['OPENAI_API_KEY'],
    });

    const model = llmConfig.model ?? 'gpt-4o-mini';
    const temperature = llmConfig.temperature ?? 0.7;

    const callLLM = async (prompt: string): Promise<string> => {
      const response = await openai.chat.completions.create({
        model,
        max_tokens: llmConfig.maxTokens ?? 4096,
        temperature,
        messages: [{ role: 'user', content: prompt }],
      });

      return response.choices[0]?.message?.content ?? '';
    };

    return async (input: TInput): Promise<TOutput> => {
      const context = {
        mockable: false,
        model,
        temperature,
        callLLM,
      };
      return agent.execute(input, context);
    };
  }

  // Use Claude Agent SDK adapter for Anthropic
  const { server } = convertLLMAnalyzerToTool(agent, inputSchema, outputSchema, llmConfig);

  return async (input: TInput): Promise<TOutput> => {
    // Access the tool handler directly and execute it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registeredTools = (server.instance as any)._registeredTools;
    const toolName = agent.manifest.name;
    const tool = registeredTools[toolName];

    if (!tool) {
      throw new Error(`Tool ${toolName} not found in MCP server`);
    }

    const response = await tool.handler(input);

    if (response.content?.[0]?.type === 'text' && response.content[0].text) {
      return JSON.parse(response.content[0].text) as TOutput;
    }

    throw new Error('Invalid tool response format');
  };
}

/**
 * Claude Agent SDK Runtime Adapter implementation
 */
const claudeAgentAdapter: RuntimeAdapter = {
  name: 'Claude Agent SDK',

  convertPureFunctionToTool: convertPureFunctionToTool as unknown as RuntimeAdapter['convertPureFunctionToTool'],

  convertPureFunctionsToTools: convertPureFunctionsToTools as unknown as RuntimeAdapter['convertPureFunctionsToTools'],

  convertLLMAnalyzerToFunction: convertLLMAnalyzerToFunction as unknown as RuntimeAdapter['convertLLMAnalyzerToFunction'],

  createPrimaryLLMConfig: (): DemoLLMConfig => ({
    provider: 'anthropic',
    apiKey: process.env['ANTHROPIC_API_KEY'],
    model: 'claude-3-5-haiku-20241022',
    temperature: 0.9,
  }),

  createSecondaryLLMConfig: (): DemoLLMConfig => ({
    provider: 'openai',
    apiKey: process.env['OPENAI_API_KEY'],
    model: 'gpt-4o-mini',
    temperature: 0.9,
  }),
};

// Run the common demo with Claude Agent SDK adapter
await runCommonDemo(claudeAgentAdapter);

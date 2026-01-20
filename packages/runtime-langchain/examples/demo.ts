/**
 * LangChain Demo - uses common demo infrastructure
 *
 * Prerequisites:
 * - OPENAI_API_KEY environment variable
 * - ANTHROPIC_API_KEY environment variable (optional, for provider comparison)
 *
 * Run with: source ~/.secrets.env && bun run demo
 */

import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';

import {
  runCommonDemo,
  type RuntimeAdapter,
} from '../../runtime-vercel-ai-sdk/examples/common-demo.js';
import { convertLLMAnalyzerToFunction } from '../src/adapters/llm-analyzer.js';
import { convertPureFunctionToTool, convertPureFunctionsToTools } from '../src/adapters/pure-function.js';


/**
 * LangChain Runtime Adapter implementation
 */
const langChainAdapter: RuntimeAdapter = {
  name: 'LangChain',

  convertPureFunctionToTool: convertPureFunctionToTool as unknown as RuntimeAdapter['convertPureFunctionToTool'],

  convertPureFunctionsToTools: convertPureFunctionsToTools as unknown as RuntimeAdapter['convertPureFunctionsToTools'],

  convertLLMAnalyzerToFunction: convertLLMAnalyzerToFunction as unknown as RuntimeAdapter['convertLLMAnalyzerToFunction'],

  createPrimaryLLMConfig: () => ({
    model: new ChatOpenAI({ modelName: 'gpt-4o-mini' }),
    temperature: 0.9,
  }),

  createSecondaryLLMConfig: () => ({
    model: new ChatAnthropic({
      modelName: 'claude-sonnet-4-5-20250929',
      anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
    }),
    temperature: 0.9,
  }),

  // LangChain tool calling demo not implemented yet - would need agent setup
  demoToolCalling: undefined,
};

// Run the common demo with LangChain adapter
runCommonDemo(langChainAdapter).catch(console.error);

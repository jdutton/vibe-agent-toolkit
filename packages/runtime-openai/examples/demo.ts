/**
 * OpenAI SDK Demo - uses common demo infrastructure
 *
 * Prerequisites:
 * - OPENAI_API_KEY environment variable
 *
 * Run with: source ~/.secrets.env && bun run demo
 */

import OpenAI from 'openai';

import {
  runCommonDemo,
  type RuntimeAdapter,
} from '../../runtime-vercel-ai-sdk/examples/common-demo.js';
import { convertLLMAnalyzerToFunction } from '../src/adapters/llm-analyzer.js';
import { convertPureFunctionToTool, convertPureFunctionsToTools } from '../src/adapters/pure-function.js';


const openaiClient = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'],
});

/**
 * OpenAI SDK Runtime Adapter implementation
 */
const openAIAdapter: RuntimeAdapter = {
  name: 'OpenAI SDK',

  convertPureFunctionToTool: convertPureFunctionToTool as unknown as RuntimeAdapter['convertPureFunctionToTool'],

  convertPureFunctionsToTools: convertPureFunctionsToTools as unknown as RuntimeAdapter['convertPureFunctionsToTools'],

  convertLLMAnalyzerToFunction: convertLLMAnalyzerToFunction as unknown as RuntimeAdapter['convertLLMAnalyzerToFunction'],

  createPrimaryLLMConfig: () => ({
    client: openaiClient,
    model: 'gpt-4o-mini',
    temperature: 0.9,
  }),

  // OpenAI SDK supports only one provider (OpenAI)
  createSecondaryLLMConfig: undefined,

  // OpenAI SDK tool calling would require manual implementation
  demoToolCalling: undefined,
};

// Run the common demo with OpenAI SDK adapter
runCommonDemo(openAIAdapter).catch(console.error);

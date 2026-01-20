import { createLLMAnalyzerTestSuite } from '@vibe-agent-toolkit/dev-tools';
import {
  NameGeneratorInputSchema,
  NameSuggestionSchema,
  nameGeneratorAgent,
} from '@vibe-agent-toolkit/vat-example-cat-agents';
import OpenAI from 'openai';

import { convertLLMAnalyzerToFunction, convertLLMAnalyzersToFunctions } from '../src/adapters/llm-analyzer.js';

// Generate complete test suite using factory
createLLMAnalyzerTestSuite({
  runtimeName: 'OpenAI SDK',
  convertLLMAnalyzerToFunction,
  convertLLMAnalyzersToFunctions,
  agent: nameGeneratorAgent,
  inputSchema: NameGeneratorInputSchema,
  outputSchema: NameSuggestionSchema,
  llmConfig: {
    client: new OpenAI({ apiKey: 'test-key' }),
    model: 'gpt-4o-mini',
  },
});

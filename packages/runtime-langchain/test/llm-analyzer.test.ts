import { ChatOpenAI } from '@langchain/openai';
import { createLLMAnalyzerTestSuite } from '@vibe-agent-toolkit/dev-tools';
import {
  NameGeneratorInputSchema,
  NameSuggestionSchema,
  nameGeneratorAgent,
} from '@vibe-agent-toolkit/vat-example-cat-agents';

import { convertLLMAnalyzerToFunction, convertLLMAnalyzersToFunctions } from '../src/adapters/llm-analyzer.js';

// Generate complete test suite using factory
createLLMAnalyzerTestSuite({
  runtimeName: 'LangChain',
  convertLLMAnalyzerToFunction,
  convertLLMAnalyzersToFunctions,
  agent: nameGeneratorAgent,
  inputSchema: NameGeneratorInputSchema,
  outputSchema: NameSuggestionSchema,
  llmConfig: {
    model: new ChatOpenAI({ modelName: 'gpt-4o-mini', apiKey: 'test-key' }),
  },
});

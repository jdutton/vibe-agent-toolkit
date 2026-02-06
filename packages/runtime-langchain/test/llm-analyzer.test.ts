import { ChatOpenAI } from '@langchain/openai';
import { createLLMAnalyzerTestSuite } from '@vibe-agent-toolkit/dev-tools';
import {
  SimpleNameInputSchema,
  SimpleNameOutputSchema,
  simpleNameGeneratorAgent,
} from '@vibe-agent-toolkit/test-agents';

import { convertLLMAnalyzerToFunction, convertLLMAnalyzersToFunctions } from '../src/adapters/llm-analyzer.js';

// Generate complete test suite using factory
createLLMAnalyzerTestSuite({
  runtimeName: 'LangChain',
  convertLLMAnalyzerToFunction,
  convertLLMAnalyzersToFunctions,
  agent: simpleNameGeneratorAgent,
  inputSchema: SimpleNameInputSchema,
  outputSchema: SimpleNameOutputSchema,
  llmConfig: {
    model: new ChatOpenAI({ modelName: 'gpt-4o-mini', apiKey: 'test-key' }),
  },
});

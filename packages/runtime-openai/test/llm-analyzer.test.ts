import { createLLMAnalyzerTestSuite } from '@vibe-agent-toolkit/dev-tools';
import {
  SimpleNameInputSchema,
  SimpleNameOutputSchema,
  simpleNameGeneratorAgent,
} from '@vibe-agent-toolkit/test-agents';
import OpenAI from 'openai';

import { convertLLMAnalyzerToFunction, convertLLMAnalyzersToFunctions } from '../src/adapters/llm-analyzer.js';

// Generate complete test suite using factory
createLLMAnalyzerTestSuite({
  runtimeName: 'OpenAI SDK',
  convertLLMAnalyzerToFunction,
  convertLLMAnalyzersToFunctions,
  agent: simpleNameGeneratorAgent,
  inputSchema: SimpleNameInputSchema,
  outputSchema: SimpleNameOutputSchema,
  llmConfig: {
    client: new OpenAI({ apiKey: 'test-key' }),
    model: 'gpt-4o-mini',
  },
});

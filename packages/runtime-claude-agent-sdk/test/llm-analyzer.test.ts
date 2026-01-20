import { createLLMAnalyzerTestSuite } from '@vibe-agent-toolkit/dev-tools';
import {
  NameGeneratorInputSchema,
  NameSuggestionSchema,
  nameGeneratorAgent,
} from '@vibe-agent-toolkit/vat-example-cat-agents';

import { convertLLMAnalyzerToTool, convertLLMAnalyzersToTools } from '../src/adapters/llm-analyzer.js';

import { createBatchToolExecutors, createToolExecutor } from './test-helpers.js';

// Generate complete test suite using factory
createLLMAnalyzerTestSuite({
  runtimeName: 'Claude Agent SDK',
  convertLLMAnalyzerToFunction: (agent, inputSchema, outputSchema, llmConfig) => {
    // Convert to MCP tool and return a function that executes it
    const { server, metadata } = convertLLMAnalyzerToTool(agent, inputSchema, outputSchema, llmConfig);
    return createToolExecutor(server, metadata.name);
  },
  convertLLMAnalyzersToFunctions: (configs, llmConfig) => {
    // Convert to MCP tools and return functions
    const { server, metadata } = convertLLMAnalyzersToTools(configs, llmConfig);
    return createBatchToolExecutors(server, Object.keys(metadata.tools));
  },
  agent: nameGeneratorAgent,
  inputSchema: NameGeneratorInputSchema,
  outputSchema: NameSuggestionSchema,
  llmConfig: {
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5',
  },
});

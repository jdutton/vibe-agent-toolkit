import { createLLMAnalyzerTestSuite } from '@vibe-agent-toolkit/dev-tools';
import {
  SimpleNameInputSchema,
  SimpleNameOutputSchema,
  simpleNameGeneratorAgent,
} from '@vibe-agent-toolkit/test-agents';
import { expect, it } from 'vitest';

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
  agent: simpleNameGeneratorAgent,
  inputSchema: SimpleNameInputSchema,
  outputSchema: SimpleNameOutputSchema,
  llmConfig: {
    apiKey: 'test-key',
    model: 'claude-sonnet-5',
  },
});

// Runtime-specific: LLM analyzers land on their own default MCP server ('vat-llm-agents'), which
// is deliberately different from the pure-function default ('vat-agents') so the two archetypes
// never collide in one `mcpServers` map. The factory adapter above discards the metadata, so this
// default — and the archetype tag riding along with it — is otherwise untested.
it('defaults batch LLM analyzers onto the vat-llm-agents MCP server', () => {
  const converted = convertLLMAnalyzersToTools(
    {
      generateName: {
        agent: simpleNameGeneratorAgent as never,
        inputSchema: SimpleNameInputSchema as never,
        outputSchema: SimpleNameOutputSchema as never,
      },
    },
    { apiKey: 'test-key', model: 'claude-sonnet-5' },
  );

  expect(converted.server.name).toBe('vat-llm-agents');
  expect(converted.metadata.serverName).toBe('vat-llm-agents');
  expect(converted.metadata.tools['generateName']).toMatchObject({
    archetype: 'llm-analyzer',
    name: 'simple-name-generator',
    toolName: 'mcp__vat-llm-agents__generateName',
  });
});

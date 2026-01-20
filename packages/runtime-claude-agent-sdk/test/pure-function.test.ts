import { createPureFunctionTestSuite } from '@vibe-agent-toolkit/dev-tools';
import { HaikuSchema, HaikuValidationResultSchema, haikuValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { expect } from 'vitest';

import { convertPureFunctionToTool, convertPureFunctionsToTools } from '../src/adapters/pure-function.js';

import { createBatchToolExecutors, createToolExecutor, getRegisteredTools } from './test-helpers.js';

// Generate complete test suite using factory
createPureFunctionTestSuite({
  runtimeName: 'Claude Agent SDK',
  convertPureFunctionToTool,
  convertPureFunctionsToTools: (configs) => {
    // Convert to MCP server and return individual tools keyed by name
    const { server, metadata } = convertPureFunctionsToTools(configs);
    return createBatchToolExecutors(server, Object.keys(metadata.tools));
  },
  agent: haikuValidatorAgent,
  inputSchema: HaikuSchema,
  outputSchema: HaikuValidationResultSchema,
  getToolFromResult: (result) => result.server,
  executeFunction: async (result, input) => {
    // For Claude Agent SDK, the actual execution would happen through query() in real usage
    // Here we directly test the tool's handler
    const executor = createToolExecutor(result.server, result.metadata.name);
    return executor(input);
  },
  parseOutput: (output) => output as { valid: boolean; syllables?: { line1: number; line2: number; line3: number }; errors?: unknown[] },
  assertToolStructure: (result) => {
    expect(result.server).toBeDefined();
    expect(result.server.name).toBeDefined();
    expect(result.server.instance).toBeDefined();
    const registeredTools = getRegisteredTools(result.server);
    expect(registeredTools).toBeDefined();
    expect(Object.keys(registeredTools).length).toBeGreaterThan(0);
    expect(result.metadata.toolName).toMatch(/^mcp__/);
  },
});

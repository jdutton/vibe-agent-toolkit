import { createPureFunctionTestSuite } from '@vibe-agent-toolkit/dev-tools';
import { HaikuSchema, HaikuValidationResultSchema, haikuValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { expect } from 'vitest';

import { convertPureFunctionToTool, convertPureFunctionsToTools } from '../src/adapters/pure-function.js';

// Generate complete test suite using factory
createPureFunctionTestSuite({
  runtimeName: 'OpenAI SDK',
  convertPureFunctionToTool,
  convertPureFunctionsToTools,
  agent: haikuValidatorAgent,
  inputSchema: HaikuSchema,
  outputSchema: HaikuValidationResultSchema,
  getToolFromResult: (result) => result.tool,
  executeFunction: async (result, input) => {
    return await result.execute(input);
  },
  parseOutput: (output) => output as { valid: boolean; syllables?: { line1: number; line2: number; line3: number }; errors?: unknown[] },
  assertToolStructure: (result) => {
    expect(result.tool.type).toBe('function');
    expect(result.tool.function).toBeDefined();
    expect(result.tool.function.name).toBeDefined();
    expect(result.tool.function.description).toBeDefined();
    // OpenAI-specific: verify JSON Schema parameters
    expect(result.tool.function.parameters).toBeDefined();
    expect(typeof result.tool.function.parameters).toBe('object');
  },
});

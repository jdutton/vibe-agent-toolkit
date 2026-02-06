import { createPureFunctionTestSuite, parseUnwrappedOutput } from '@vibe-agent-toolkit/dev-tools';
import {
  SimpleValidationInputSchema,
  SimpleValidationOutputSchema,
  simpleValidatorAgent,
} from '@vibe-agent-toolkit/test-agents';
import { expect } from 'vitest';

import { convertPureFunctionToTool, convertPureFunctionsToTools } from '../src/adapters/pure-function.js';

// Generate complete test suite using factory
createPureFunctionTestSuite({
  runtimeName: 'OpenAI SDK',
  convertPureFunctionToTool,
  convertPureFunctionsToTools,
  agent: simpleValidatorAgent,
  inputSchema: SimpleValidationInputSchema,
  outputSchema: SimpleValidationOutputSchema,
  getToolFromResult: (result) => result.tool,
  executeFunction: async (result, input) => {
    return await result.execute(input);
  },
  parseOutput: parseUnwrappedOutput,
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

import { createPureFunctionTestSuite } from '@vibe-agent-toolkit/dev-tools';
import {
  SimpleValidationInputSchema,
  SimpleValidationOutputSchema,
  simpleValidatorAgent,
} from '@vibe-agent-toolkit/test-agents';
import { expect } from 'vitest';

import { convertPureFunctionToTool, convertPureFunctionsToTools } from '../src/adapters/pure-function.js';

// Generate complete test suite using factory
createPureFunctionTestSuite({
  runtimeName: 'LangChain',
  convertPureFunctionToTool,
  convertPureFunctionsToTools,
  agent: simpleValidatorAgent,
  inputSchema: SimpleValidationInputSchema,
  outputSchema: SimpleValidationOutputSchema,
  getToolFromResult: (result) => result.tool,
  executeFunction: async (result, input) => {
    const outputString = await result.tool.invoke(input);
    return outputString;
  },
  parseOutput: (output) => {
    // LangChain tools return JSON string - adapter already unwraps envelope
    return JSON.parse(output as string) as { valid: boolean; syllables?: { line1: number; line2: number; line3: number }; errors?: unknown[] };
  },
  assertToolStructure: (result) => {
    expect(result.tool.name).toBeDefined();
    expect(result.tool.description).toBeDefined();
  },
});

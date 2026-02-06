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
  runtimeName: 'Vercel AI',
  convertPureFunctionToTool,
  convertPureFunctionsToTools,
  agent: simpleValidatorAgent,
  inputSchema: SimpleValidationInputSchema,
  outputSchema: SimpleValidationOutputSchema,
  getToolFromResult: (result) => result.tool,
  executeFunction: async (result, input) => {
    // Type assertion needed because of generic tool type constraints
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const execute = result.tool.execute as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await execute(input, {} as any);
  },
  parseOutput: parseUnwrappedOutput,
  assertToolStructure: (result) => {
    expect(result.tool.description).toBeDefined();
    expect(result.tool.inputSchema).toBeDefined();
  },
});

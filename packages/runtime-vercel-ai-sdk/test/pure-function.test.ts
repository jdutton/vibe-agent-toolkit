import { createPureFunctionTestSuite, parseUnwrappedOutput } from '@vibe-agent-toolkit/dev-tools';
import { HaikuSchema, HaikuValidationResultSchema, haikuValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { expect } from 'vitest';

import { convertPureFunctionToTool, convertPureFunctionsToTools } from '../src/adapters/pure-function.js';

// Generate complete test suite using factory
createPureFunctionTestSuite({
  runtimeName: 'Vercel AI',
  convertPureFunctionToTool,
  convertPureFunctionsToTools,
  agent: haikuValidatorAgent,
  inputSchema: HaikuSchema,
  outputSchema: HaikuValidationResultSchema,
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

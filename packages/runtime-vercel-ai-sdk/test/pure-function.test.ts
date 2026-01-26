import { createPureFunctionTestSuite } from '@vibe-agent-toolkit/dev-tools';
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
  parseOutput: (output) => {
    // Unwrap OneShotAgentOutput envelope
    const envelope = output as { result: { status: string; data?: unknown; error?: string }; metadata?: unknown };
    if (envelope.result.status === 'success') {
      return envelope.result.data as { valid: boolean; syllables?: { line1: number; line2: number; line3: number }; errors?: unknown[] };
    }
    // Return error as invalid result
    return { valid: false, errors: [envelope.result.error] };
  },
  assertToolStructure: (result) => {
    expect(result.tool.description).toBeDefined();
    expect(result.tool.inputSchema).toBeDefined();
  },
});

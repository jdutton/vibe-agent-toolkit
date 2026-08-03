import { createPureFunctionTestSuite, parseUnwrappedOutput } from '@vibe-agent-toolkit/dev-tools';
import {
  SimpleValidationInputSchema,
  SimpleValidationOutputSchema,
  simpleValidatorAgent,
} from '@vibe-agent-toolkit/test-agents';
import { expect, it } from 'vitest';

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
    const execute = result.tool.execute;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await execute(input, {} as any);
  },
  parseOutput: parseUnwrappedOutput,
  assertToolStructure: (result) => {
    expect(result.tool.description).toBeDefined();
    expect(result.tool.inputSchema).toBeDefined();
  },
});

// Runtime-specific: AI SDK v5 named this field `parameters`; v6 renamed it to `inputSchema`. The
// adapter type-asserts its way past tool()'s compile-time constraints, so nothing but a runtime
// check catches a regression back to the v5 shape — the factory only asserts `inputSchema` is
// *defined*, which a v5-shaped tool carrying both keys would also satisfy.
it('emits an AI SDK v6 tool keyed on inputSchema with no v5 parameters field', () => {
  const result = convertPureFunctionToTool(
    simpleValidatorAgent,
    SimpleValidationInputSchema,
    SimpleValidationOutputSchema,
  );

  expect(Object.keys(result.tool)).toEqual(['description', 'inputSchema', 'execute']);
  expect(result.tool).not.toHaveProperty('parameters');
  // Vercel consumes the Zod schema directly; it must be the very object we passed in, not a copy.
  expect(result.tool.inputSchema).toBe(SimpleValidationInputSchema);
  expect(result.tool.description).toBe('Validates haiku syllable patterns');
});

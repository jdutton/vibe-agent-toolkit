import { DynamicStructuredTool } from '@langchain/core/tools';
import { createPureFunctionTestSuite, testData } from '@vibe-agent-toolkit/dev-tools';
import {
  SimpleValidationInputSchema,
  SimpleValidationOutputSchema,
  simpleValidatorAgent,
} from '@vibe-agent-toolkit/test-agents';
import { expect, it } from 'vitest';

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

// Runtime-specific: LangChain is the only adapter that serialises the agent's output — its tools
// must resolve to a string, so the adapter JSON.stringify()s the validated result. The factory
// hides that by JSON.parse()ing in its parseOutput hook, which would keep passing if the adapter
// started returning a plain object (and would then break real LangChain agent executors).
it('produces a DynamicStructuredTool that resolves to a JSON string, not an object', async () => {
  const { tool } = convertPureFunctionToTool(
    simpleValidatorAgent,
    SimpleValidationInputSchema,
    SimpleValidationOutputSchema,
  );

  expect(tool).toBeInstanceOf(DynamicStructuredTool);
  // LangChain keeps the Zod schema itself rather than a JSON Schema translation of it.
  expect(tool.schema).toBe(SimpleValidationInputSchema);

  const serialized = await tool.invoke(testData.validHaiku);

  expect(typeof serialized).toBe('string');
  expect(JSON.parse(serialized as string)).toEqual({
    syllables: testData.validHaikuSyllables,
    valid: true,
  });
});

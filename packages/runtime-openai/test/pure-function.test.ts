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

/** Pulls the object schema out of `parameters`, whether it is inlined or wrapped in a `$ref`. */
function resolveParameterSchema(parameters: unknown): Record<string, unknown> {
  const root = parameters as {
    $ref?: string;
    definitions?: Record<string, Record<string, unknown>>;
  };
  if (typeof root.$ref !== 'string') {
    return parameters as Record<string, unknown>;
  }
  const definitionName = root.$ref.replace('#/definitions/', '');
  const definition = root.definitions?.[definitionName];
  if (!definition) {
    throw new Error(`Dangling $ref in OpenAI parameters: ${root.$ref}`);
  }
  return definition;
}

// Runtime-specific: OpenAI is the only adapter that hands the model a JSON Schema instead of a Zod
// schema, so the zodToJsonSchema translation is its own failure surface. The factory only checks
// that `parameters` is an object; it never looks inside. The model's ability to fill the arguments
// depends entirely on the per-property `.describe()` text surviving that translation.
it('translates the Zod input schema into a JSON Schema that preserves field descriptions', () => {
  const { tool } = convertPureFunctionToTool(
    simpleValidatorAgent,
    SimpleValidationInputSchema,
    SimpleValidationOutputSchema,
  );

  // OpenAI rejects function names outside ^[a-zA-Z0-9_-]{1,64}$.
  expect(tool.function.name).toBe('haiku-validator');
  expect(tool.function.name).toMatch(/^[\w-]{1,64}$/);

  const schema = resolveParameterSchema(tool.function.parameters);
  expect(schema['type']).toBe('object');
  expect(schema['required']).toEqual(['line1', 'line2', 'line3']);
  expect(schema['properties']).toMatchObject({
    line1: { description: 'First line of haiku', type: 'string' },
    line3: { description: 'Third line of haiku', type: 'string' },
  });
});

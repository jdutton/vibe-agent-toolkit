import { HaikuSchema, HaikuValidationResultSchema, haikuValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { describe, expect, it } from 'vitest';

import { convertPureFunctionToTool, convertPureFunctionsToTools } from '../src/adapters/pure-function.js';

describe('convertPureFunctionToTool', () => {
  it('should convert haiku validator to Vercel AI tool', () => {
    const result = convertPureFunctionToTool(
      haikuValidatorAgent,
      HaikuSchema,
      HaikuValidationResultSchema,
    );

    expect(result.tool).toBeDefined();
    expect(result.tool.description).toBeDefined();
    expect(result.tool.parameters).toBeDefined();
    expect(result.metadata.name).toBe('haiku-validator');
    expect(result.metadata.archetype).toBe('pure-function');
    expect(result.inputSchema).toBe(HaikuSchema);
    expect(result.outputSchema).toBe(HaikuValidationResultSchema);
  });

  it('should preserve agent metadata', () => {
    const result = convertPureFunctionToTool(
      haikuValidatorAgent,
      HaikuSchema,
      HaikuValidationResultSchema,
    );

    expect(result.metadata.name).toBe('haiku-validator');
    expect(result.metadata.description).toContain('Validates haiku');
    expect(result.metadata.version).toBe('1.0.0');
  });
});

describe('convertPureFunctionsToTools', () => {
  it('should batch convert multiple agents', () => {
    const tools = convertPureFunctionsToTools({
      validateHaiku: {
        agent: haikuValidatorAgent as never,
        inputSchema: HaikuSchema as never,
        outputSchema: HaikuValidationResultSchema as never,
      },
    });

    expect(tools.validateHaiku).toBeDefined();
    expect(tools.validateHaiku.description).toBeDefined();
    expect(tools.validateHaiku.parameters).toBeDefined();
  });

  it('should return tools keyed by provided names', () => {
    const tools = convertPureFunctionsToTools({
      haikuValidator: {
        agent: haikuValidatorAgent as never,
        inputSchema: HaikuSchema as never,
        outputSchema: HaikuValidationResultSchema as never,
      },
      anotherHaikuValidator: {
        agent: haikuValidatorAgent as never,
        inputSchema: HaikuSchema as never,
        outputSchema: HaikuValidationResultSchema as never,
      },
    });

    expect(Object.keys(tools)).toEqual(['haikuValidator', 'anotherHaikuValidator']);
  });
});

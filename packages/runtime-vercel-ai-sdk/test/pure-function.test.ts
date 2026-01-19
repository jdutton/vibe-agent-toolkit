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
    expect(result.tool.inputSchema).toBeDefined();
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

  it('should execute the agent when tool is called', async () => {
    const result = convertPureFunctionToTool(
      haikuValidatorAgent,
      HaikuSchema,
      HaikuValidationResultSchema,
    );

    // Verify execute function exists
    expect(result.tool.execute).toBeDefined();

    // Actually execute the tool through the adapter
    const validHaiku = {
      line1: 'Orange fur ablaze',
      line2: 'Whiskers twitch in winter sun',
      line3: 'Cat dreams of dinner',
    };

    // Type assertion needed because of generic tool type constraints
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const execute = result.tool.execute as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = await execute(validHaiku, {} as any);

    // Verify the adapter properly executed the agent
    expect(output.valid).toBe(true);
    expect(output.syllables).toEqual({ line1: 5, line2: 7, line3: 5 });
  });

  it('should handle invalid input through the adapter', async () => {
    const result = convertPureFunctionToTool(
      haikuValidatorAgent,
      HaikuSchema,
      HaikuValidationResultSchema,
    );

    const invalidHaiku = {
      line1: 'Cat',
      line2: 'Meow',
      line3: 'Purr',
    };

    // Type assertion needed because of generic tool type constraints
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const execute = result.tool.execute as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = await execute(invalidHaiku, {} as any);

    expect(output.valid).toBe(false);
    expect(output.errors.length).toBeGreaterThan(0);
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
    expect(tools.validateHaiku.inputSchema).toBeDefined();
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

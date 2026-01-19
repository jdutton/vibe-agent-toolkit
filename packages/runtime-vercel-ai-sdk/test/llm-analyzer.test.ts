import {
  NameGeneratorInputSchema,
  NameSuggestionSchema,
  nameGeneratorAgent,
} from '@vibe-agent-toolkit/vat-example-cat-agents';
import { describe, expect, it } from 'vitest';

import { convertLLMAnalyzerToFunction, convertLLMAnalyzersToFunctions } from '../src/adapters/llm-analyzer.js';

const TEST_MODEL = 'test-model';

describe('convertLLMAnalyzerToFunction', () => {
  it('should convert LLM analyzer to executable function', () => {
    const generateName = convertLLMAnalyzerToFunction(
      nameGeneratorAgent,
      NameGeneratorInputSchema,
      NameSuggestionSchema,
      {
        model: TEST_MODEL,
        temperature: 0.7,
      },
    );

    expect(generateName).toBeInstanceOf(Function);
  });

  it('should return async function with correct signature', () => {
    const generateName = convertLLMAnalyzerToFunction(
      nameGeneratorAgent,
      NameGeneratorInputSchema,
      NameSuggestionSchema,
      {
        model: TEST_MODEL,
        temperature: 0.9,
      },
    );

    // Verify it returns a Promise when called
    const result = generateName({
      characteristics: {
        physical: { furColor: 'Orange' },
        behavioral: { personality: ['Distinguished'] },
        description: 'A noble cat',
      },
    });

    expect(result).toBeInstanceOf(Promise);

    // Clean up the promise to avoid unhandled rejection
    result.catch(() => {
      // Expected to fail without real LLM - that's ok for structure test
    });
  });

  it('should validate input schema before execution', async () => {
    const generateName = convertLLMAnalyzerToFunction(
      nameGeneratorAgent,
      NameGeneratorInputSchema,
      NameSuggestionSchema,
      {
        model: TEST_MODEL,
      },
    );

    // Invalid input should throw during schema validation
    await expect(
      generateName({
        // Missing required characteristics field
      } as never),
    ).rejects.toThrow();
  });
});

describe('convertLLMAnalyzersToFunctions', () => {
  it('should batch convert multiple analyzers', () => {
    const functions = convertLLMAnalyzersToFunctions(
      {
        generateName: {
          agent: nameGeneratorAgent as never,
          inputSchema: NameGeneratorInputSchema as never,
          outputSchema: NameSuggestionSchema as never,
        },
      },
      {
        model: TEST_MODEL,
        temperature: 0.8,
      },
    );

    expect(functions.generateName).toBeDefined();
    expect(functions.generateName).toBeInstanceOf(Function);
  });

  it('should return functions keyed by provided names', () => {
    const functions = convertLLMAnalyzersToFunctions(
      {
        nameGenerator1: {
          agent: nameGeneratorAgent as never,
          inputSchema: NameGeneratorInputSchema as never,
          outputSchema: NameSuggestionSchema as never,
        },
        nameGenerator2: {
          agent: nameGeneratorAgent as never,
          inputSchema: NameGeneratorInputSchema as never,
          outputSchema: NameSuggestionSchema as never,
        },
      },
      {
        model: TEST_MODEL,
      },
    );

    expect(Object.keys(functions)).toEqual(['nameGenerator1', 'nameGenerator2']);
  });
});

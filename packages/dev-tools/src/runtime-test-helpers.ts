/**
 * Shared test factories for runtime adapter testing
 * Eliminates duplication and ensures consistent coverage across runtime-vercel-ai-sdk, runtime-langchain, runtime-openai
 */

import { describe, expect, it } from 'vitest';

/** Test data shared across all runtime adapter tests */
export const testData = {
  validHaiku: {
    line1: 'Orange fur ablaze',
    line2: 'Whiskers twitch in winter sun',
    line3: 'Cat dreams of dinner',
  },
  validHaikuSyllables: { line1: 5, line2: 7, line3: 5 },
  invalidHaiku: {
    line1: 'Cat',
    line2: 'Meow',
    line3: 'Purr',
  },
  catCharacteristics: {
    physical: { furColor: 'Orange' },
    behavioral: { personality: ['Distinguished'] },
    description: 'A noble cat',
  },
} as const;

/**
 * Common parseOutput function for adapters that unwrap envelopes internally
 * Use for: OpenAI SDK, Claude Agent SDK
 */
export function parseUnwrappedOutput(output: unknown): {
  valid: boolean;
  syllables?: { line1: number; line2: number; line3: number };
  errors?: unknown[];
} {
  return output as {
    valid: boolean;
    syllables?: { line1: number; line2: number; line3: number };
    errors?: unknown[];
  };
}

/**
 * Configuration for runtime-specific pure function test behavior
 */
export interface PureFunctionTestConfig<TAgent, TSchema, TResult> {
  /** Runtime name for test descriptions (e.g., "Vercel AI", "LangChain", "OpenAI") */
  runtimeName: string;
  /** The conversion function to test */
  convertPureFunctionToTool: (agent: TAgent, inputSchema: TSchema, outputSchema: TSchema) => TResult;
  /** The batch conversion function to test */
  convertPureFunctionsToTools: (configs: Record<string, { agent: TAgent; inputSchema: TSchema; outputSchema: TSchema }>) => Record<string, unknown>;
  /** The test agent */
  agent: TAgent;
  /** Input schema */
  inputSchema: TSchema;
  /** Output schema */
  outputSchema: TSchema;
  /** How to access the tool from the result (runtime-specific) */
  getToolFromResult: (result: TResult) => unknown;
  /** How to execute the tool (runtime-specific) */
  executeFunction: (result: TResult, input: unknown) => Promise<unknown>;
  /** How to parse the output (some runtimes return JSON strings) */
  parseOutput: (output: unknown) => { valid: boolean; syllables?: { line1: number; line2: number; line3: number }; errors?: unknown[] };
  /** Runtime-specific assertions for tool structure */
  assertToolStructure: (result: TResult) => void;
}

/**
 * Creates a complete pure function test suite for a runtime adapter
 * Ensures all runtimes test exactly the same behavior
 */
export function createPureFunctionTestSuite<TAgent, TSchema, TResult>(
  config: PureFunctionTestConfig<TAgent, TSchema, TResult>,
): void {
  const {
    runtimeName,
    convertPureFunctionToTool,
    convertPureFunctionsToTools,
    agent,
    inputSchema,
    outputSchema,
    getToolFromResult,
    executeFunction,
    parseOutput,
    assertToolStructure,
  } = config;

  describe('convertPureFunctionToTool', () => {
    it(`should convert haiku validator to ${runtimeName} tool`, () => {
      const result = convertPureFunctionToTool(agent, inputSchema, outputSchema);

      const tool = getToolFromResult(result);
      expect(tool).toBeDefined();
      assertToolStructure(result);
      expect((result as { metadata: { name: string; archetype: string } }).metadata.name).toBe('haiku-validator');
      expect((result as { metadata: { archetype: string } }).metadata.archetype).toBe('pure-function-tool');
    });

    it('should preserve agent metadata', () => {
      const result = convertPureFunctionToTool(agent, inputSchema, outputSchema);

      const metadata = (result as { metadata: { name: string; description: string; version: string } }).metadata;
      expect(metadata.name).toBe('haiku-validator');
      expect(metadata.description).toContain('Validates haiku');
      expect(metadata.version).toBe('1.0.0');
    });

    it('should execute the agent when tool is called', async () => {
      const result = convertPureFunctionToTool(agent, inputSchema, outputSchema);

      const output = await executeFunction(result, testData.validHaiku);
      const parsed = parseOutput(output);

      expect(parsed.valid).toBe(true);
      expect(parsed.syllables).toEqual(testData.validHaikuSyllables);
    });

    it('should handle invalid input through the adapter', async () => {
      const result = convertPureFunctionToTool(agent, inputSchema, outputSchema);

      const output = await executeFunction(result, testData.invalidHaiku);
      const parsed = parseOutput(output);

      expect(parsed.valid).toBe(false);
      expect(parsed.errors?.length).toBeGreaterThan(0);
    });
  });

  describe('convertPureFunctionsToTools', () => {
    it('should batch convert multiple agents', () => {
      const tools = convertPureFunctionsToTools({
        validateHaiku: {
          agent: agent as never,
          inputSchema: inputSchema as never,
          outputSchema: outputSchema as never,
        },
      });

      expect(tools['validateHaiku']).toBeDefined();
    });

    it('should return tools keyed by provided names', () => {
      const tools = convertPureFunctionsToTools({
        haikuValidator: {
          agent: agent as never,
          inputSchema: inputSchema as never,
          outputSchema: outputSchema as never,
        },
        anotherHaikuValidator: {
          agent: agent as never,
          inputSchema: inputSchema as never,
          outputSchema: outputSchema as never,
        },
      });

      expect(Object.keys(tools)).toEqual(['haikuValidator', 'anotherHaikuValidator']);
    });
  });
}

/**
 * Configuration for runtime-specific LLM analyzer test behavior
 */
export interface LLMAnalyzerTestConfig<TAgent, TSchema, TLLMConfig> {
  /** Runtime name for test descriptions */
  runtimeName: string;
  /** The conversion function to test */
  convertLLMAnalyzerToFunction: (
    agent: TAgent,
    inputSchema: TSchema,
    outputSchema: TSchema,
    llmConfig: TLLMConfig,
  ) => (input: unknown) => Promise<unknown>;
  /** The batch conversion function to test */
  convertLLMAnalyzersToFunctions: (
    configs: Record<string, { agent: TAgent; inputSchema: TSchema; outputSchema: TSchema }>,
    llmConfig: TLLMConfig,
  ) => Record<string, (input: unknown) => Promise<unknown>>;
  /** The test agent */
  agent: TAgent;
  /** Input schema */
  inputSchema: TSchema;
  /** Output schema */
  outputSchema: TSchema;
  /** LLM config for testing (runtime-specific) */
  llmConfig: TLLMConfig;
}

/**
 * Creates a complete LLM analyzer test suite for a runtime adapter
 * Ensures all runtimes test exactly the same behavior
 */
export function createLLMAnalyzerTestSuite<TAgent, TSchema, TLLMConfig>(
  config: LLMAnalyzerTestConfig<TAgent, TSchema, TLLMConfig>,
): void {
  const {
    runtimeName,
    convertLLMAnalyzerToFunction,
    convertLLMAnalyzersToFunctions,
    agent,
    inputSchema,
    outputSchema,
    llmConfig,
  } = config;

  describe('convertLLMAnalyzerToFunction', () => {
    it(`should convert LLM analyzer to executable function for ${runtimeName}`, () => {
      const generateName = convertLLMAnalyzerToFunction(
        agent,
        inputSchema,
        outputSchema,
        { ...llmConfig, temperature: 0.7 } as TLLMConfig,
      );

      expect(generateName).toBeInstanceOf(Function);
    });

    it('should return async function with correct signature', () => {
      const generateName = convertLLMAnalyzerToFunction(
        agent,
        inputSchema,
        outputSchema,
        { ...llmConfig, temperature: 0.9 } as TLLMConfig,
      );

      const result = generateName({
        characteristics: testData.catCharacteristics,
      });

      expect(result).toBeInstanceOf(Promise);

      // Clean up the promise to avoid unhandled rejection
      result.catch(() => {
        // Expected to fail without real LLM - that's ok for structure test
      });
    });

    it('should validate input schema before execution', async () => {
      const generateName = convertLLMAnalyzerToFunction(agent, inputSchema, outputSchema, llmConfig);

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
            agent: agent as never,
            inputSchema: inputSchema as never,
            outputSchema: outputSchema as never,
          },
        },
        { ...llmConfig, temperature: 0.8 } as TLLMConfig,
      );

      expect(functions['generateName']).toBeDefined();
      expect(functions['generateName']).toBeInstanceOf(Function);
    });

    it('should return functions keyed by provided names', () => {
      const functions = convertLLMAnalyzersToFunctions(
        {
          nameGenerator1: {
            agent: agent as never,
            inputSchema: inputSchema as never,
            outputSchema: outputSchema as never,
          },
          nameGenerator2: {
            agent: agent as never,
            inputSchema: inputSchema as never,
            outputSchema: outputSchema as never,
          },
        },
        llmConfig,
      );

      expect(Object.keys(functions)).toEqual(['nameGenerator1', 'nameGenerator2']);
    });
  });
}

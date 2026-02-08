/**
 * LLM Regression Tests
 *
 * These tests make real LLM API calls and are expensive/slow.
 * They are skipped by default and only run when RUN_LLM_TESTS=true.
 *
 * Usage:
 *   bun run test:llm-regression
 *   RUN_LLM_TESTS=true bun test test/llm-regression.test.ts
 */

import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import {
  SimpleNameInputSchema,
  SimpleNameOutputSchema,
  SimpleValidationInputSchema,
  SimpleValidationOutputSchema,
  simpleNameGeneratorAgent,
  simpleValidatorAgent,
  type SimpleNameOutput,
} from '@vibe-agent-toolkit/test-agents';
import { describe, expect, it } from 'vitest';

import { convertLLMAnalyzerToFunction } from '../src/adapters/llm-analyzer.js';
import { convertPureFunctionToTool } from '../src/adapters/pure-function.js';

// Skip all tests unless RUN_LLM_TESTS=true
const shouldRunLLMTests = process.env['RUN_LLM_TESTS'] === 'true';
const describeIfLLMTests = shouldRunLLMTests ? describe : describe.skip;

// Verify API keys are set
const hasOpenAIKey = !!process.env['OPENAI_API_KEY'];
const hasAnthropicKey = !!process.env['ANTHROPIC_API_KEY'];

// Test data
const simpleTest1 = {
  adjective: 'Swift',
  noun: 'River',
};

const simpleTest2 = {
  adjective: 'Golden',
  noun: 'Mountain',
};

const simpleTest3 = {
  adjective: 'Bright',
  noun: 'Star',
};

// Helper to verify LLM analyzer output structure
function verifyNameSuggestion(result: SimpleNameOutput, providerName: string) {
  expect(result).toBeDefined();
  expect(typeof result.name).toBe('string');
  expect(result.name.length).toBeGreaterThan(0);
  expect(typeof result.reasoning).toBe('string');
  expect(result.reasoning.length).toBeGreaterThan(0);

  if (result.alternatives) {
    expect(Array.isArray(result.alternatives)).toBe(true);
    expect(result.alternatives.length).toBeGreaterThanOrEqual(2);
    expect(result.alternatives.length).toBeLessThanOrEqual(3);
  }

  console.log(`✅ ${providerName} generated name: "${String(result.name)}"`);
}

describeIfLLMTests('LLM Regression Tests', () => {
  describe('OpenAI Integration', () => {
    it('should work with pure function tools', async () => {
      if (!hasOpenAIKey) {
        console.warn('⚠️  OPENAI_API_KEY not set, skipping OpenAI test');
        return;
      }

      const { tool } = convertPureFunctionToTool(
        simpleValidatorAgent,
        SimpleValidationInputSchema,
        SimpleValidationOutputSchema,
      );

      const validInput = {
        text: 'Hello, World!',
        minLength: 5,
        maxLength: 50,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (tool.execute as any)(validInput, {} as any);

      expect(result).toBeDefined();
      expect(result.valid).toBe(true);
    }, 30000); // 30s timeout for API calls

    it('should work with LLM analyzer functions', async () => {
      if (!hasOpenAIKey) {
        console.warn('⚠️  OPENAI_API_KEY not set, skipping OpenAI test');
        return;
      }

      const generateName = convertLLMAnalyzerToFunction(
        simpleNameGeneratorAgent,
        SimpleNameInputSchema,
        SimpleNameOutputSchema,
        {
          model: openai('gpt-4o-mini'),
          temperature: 0.9,
        },
      );

      const result = await generateName(simpleTest1);
      verifyNameSuggestion(result, 'OpenAI');
    }, 30000);
  });

  describe('Anthropic Integration', () => {
    it('should work with LLM analyzer functions', async () => {
      if (!hasAnthropicKey) {
        console.warn('⚠️  ANTHROPIC_API_KEY not set, skipping Anthropic test');
        return;
      }

      const generateName = convertLLMAnalyzerToFunction(
        simpleNameGeneratorAgent,
        SimpleNameInputSchema,
        SimpleNameOutputSchema,
        {
          model: anthropic('claude-sonnet-4-5-20250929'),
          temperature: 0.9,
        },
      );

      const result = await generateName(simpleTest2);
      verifyNameSuggestion(result, 'Anthropic');
    }, 30000);
  });

  describe('Provider Agnostic Behavior', () => {
    it('should produce valid output from both providers using same adapter', async () => {
      if (!hasOpenAIKey || !hasAnthropicKey) {
        console.warn('⚠️  Missing API keys, skipping cross-provider test');
        return;
      }

      // Create functions with both providers
      const generateNameOpenAI = convertLLMAnalyzerToFunction(
        simpleNameGeneratorAgent,
        SimpleNameInputSchema,
        SimpleNameOutputSchema,
        { model: openai('gpt-4o-mini'), temperature: 0.9 },
      );

      const generateNameAnthropic = convertLLMAnalyzerToFunction(
        simpleNameGeneratorAgent,
        SimpleNameInputSchema,
        SimpleNameOutputSchema,
        { model: anthropic('claude-sonnet-4-5-20250929'), temperature: 0.9 },
      );

      // Call both providers in parallel with same input
      const [resultOpenAI, resultAnthropic] = await Promise.all([
        generateNameOpenAI(simpleTest3),
        generateNameAnthropic(simpleTest3),
      ]);

      // Verify both outputs
      verifyNameSuggestion(resultOpenAI, 'OpenAI');
      verifyNameSuggestion(resultAnthropic, 'Anthropic');
      console.log('✅ Both providers work with same adapter code');
    }, 60000); // 60s timeout for parallel calls
  });
});

// If tests are skipped, print helpful message
if (!shouldRunLLMTests) {
  describe('LLM Regression Tests (Skipped)', () => {
    it('should be run with RUN_LLM_TESTS=true', () => {
      console.log('\n💡 LLM regression tests are skipped by default');
      console.log('   To run them: bun run test:llm-regression\n');
      // Assertion to satisfy sonarjs/assertions-in-tests
      expect(shouldRunLLMTests).toBe(false);
    });
  });
}

import { createLLMAnalyzerTestSuite } from '@vibe-agent-toolkit/dev-tools';
import {
  SimpleNameInputSchema,
  SimpleNameOutputSchema,
  simpleNameGeneratorAgent,
} from '@vibe-agent-toolkit/test-agents';
import { generateText } from 'ai';
import { expect, it, vi } from 'vitest';

import { convertLLMAnalyzerToFunction, convertLLMAnalyzersToFunctions } from '../src/adapters/llm-analyzer.js';

vi.mock('ai', () => ({ generateText: vi.fn() }));

const TEST_MODEL = 'test-model';

// Generate complete test suite using factory
createLLMAnalyzerTestSuite({
  runtimeName: 'Vercel AI SDK',
  convertLLMAnalyzerToFunction,
  convertLLMAnalyzersToFunctions,
  agent: simpleNameGeneratorAgent,
  inputSchema: SimpleNameInputSchema,
  outputSchema: SimpleNameOutputSchema,
  llmConfig: { model: TEST_MODEL },
});

// Runtime-specific: Vercel is the only adapter that forwards free-form provider options
// (`additionalSettings`) into the generateText() call, and it omits unset knobs entirely rather
// than passing undefined — some providers reject an explicit `maxTokens: undefined`. The factory
// suite never reaches generateText (its execution cases reject during input validation).
it('spreads additionalSettings into generateText and omits unset knobs', async () => {
  vi.mocked(generateText).mockResolvedValue({
    text: '{"name":"Emberpaw","reasoning":"A cat of quiet fire"}',
  } as unknown as Awaited<ReturnType<typeof generateText>>);

  const generateName = convertLLMAnalyzerToFunction(
    simpleNameGeneratorAgent,
    SimpleNameInputSchema,
    SimpleNameOutputSchema,
    { additionalSettings: { topP: 0.25 }, model: TEST_MODEL, temperature: 0.4 },
  );

  const output = await generateName({ adjective: 'Quiet', noun: 'Ember' });

  expect(output).toEqual({ name: 'Emberpaw', reasoning: 'A cat of quiet fire' });
  const settings = vi.mocked(generateText).mock.calls.at(-1)?.[0] as Record<string, unknown>;
  expect(settings['topP']).toBe(0.25);
  expect(settings['temperature'] as number).toBeCloseTo(0.4, 10);
  expect(settings['model']).toBe(TEST_MODEL);
  expect(settings['prompt']).toContain('Noun: "Ember"');
  expect(settings).not.toHaveProperty('maxTokens');
});

// `temperature: 0` is the setting most likely to be passed deliberately by anyone asking an LLM
// for structured output, and it is the one value a truthiness guard discards. This adapter used
// to spread `llmConfig.temperature ? {...} : {}`, so a caller who asked for deterministic output
// silently got the provider default instead — while the same function's agent context spelled it
// `?? 0.7`, so the two halves disagreed about whether 0 was a real setting. The test above cannot
// see it: 0.4 is truthy, and every value a suppression bug still forwards is truthy.
it('forwards an explicit temperature of 0 rather than dropping it as falsy', async () => {
  vi.mocked(generateText).mockResolvedValue({
    text: '{"name":"Emberpaw","reasoning":"A cat of quiet fire"}',
  } as unknown as Awaited<ReturnType<typeof generateText>>);

  const generateName = convertLLMAnalyzerToFunction(
    simpleNameGeneratorAgent,
    SimpleNameInputSchema,
    SimpleNameOutputSchema,
    { model: TEST_MODEL, temperature: 0 },
  );

  await generateName({ adjective: 'Quiet', noun: 'Ember' });

  const settings = vi.mocked(generateText).mock.calls.at(-1)?.[0] as Record<string, unknown>;
  expect(settings['temperature']).toBe(0);
});

import { createLLMAnalyzerTestSuite } from '@vibe-agent-toolkit/dev-tools';
import {
  SimpleNameInputSchema,
  SimpleNameOutputSchema,
  simpleNameGeneratorAgent,
} from '@vibe-agent-toolkit/test-agents';
import OpenAI from 'openai';
import { expect, it, vi } from 'vitest';

import { convertLLMAnalyzerToFunction, convertLLMAnalyzersToFunctions } from '../src/adapters/llm-analyzer.js';

const TEST_MODEL = 'gpt-4o-mini';

// Generate complete test suite using factory
createLLMAnalyzerTestSuite({
  runtimeName: 'OpenAI SDK',
  convertLLMAnalyzerToFunction,
  convertLLMAnalyzersToFunctions,
  agent: simpleNameGeneratorAgent,
  inputSchema: SimpleNameInputSchema,
  outputSchema: SimpleNameOutputSchema,
  llmConfig: {
    client: new OpenAI({ apiKey: 'test-key' }),
    model: TEST_MODEL,
  },
});

// Runtime-specific: the adapter has to rename VAT's camelCase `maxTokens` to the snake_case
// `max_tokens` the Chat Completions API expects, and wrap the agent's prompt in a single-element
// `messages` array. The factory suite never reaches a chat completion (its execution cases reject
// during input validation), so this request mapping is only observable with a stubbed client.
it('maps VAT config onto a Chat Completions request and unwraps the reply', async () => {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content: '{"name":"Rivermist","reasoning":"Speed meets water"}' } }],
  });

  const generateName = convertLLMAnalyzerToFunction(
    simpleNameGeneratorAgent,
    SimpleNameInputSchema,
    SimpleNameOutputSchema,
    {
      client: { chat: { completions: { create } } } as unknown as OpenAI,
      maxTokens: 256,
      model: TEST_MODEL,
      temperature: 0.3,
    },
  );

  const output = await generateName({ adjective: 'Swift', noun: 'River' });

  expect(output).toEqual({ name: 'Rivermist', reasoning: 'Speed meets water' });
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0]?.[0]).toEqual({
    max_tokens: 256,
    messages: [{ content: expect.stringContaining('Adjective: "Swift"'), role: 'user' }],
    model: TEST_MODEL,
    temperature: 0.3,
  });
});

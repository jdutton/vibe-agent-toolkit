import { ChatOpenAI } from '@langchain/openai';
import { createLLMAnalyzerTestSuite } from '@vibe-agent-toolkit/dev-tools';
import {
  SimpleNameInputSchema,
  SimpleNameOutputSchema,
  simpleNameGeneratorAgent,
} from '@vibe-agent-toolkit/test-agents';
import { expect, it, vi } from 'vitest';

import { convertLLMAnalyzerToFunction, convertLLMAnalyzersToFunctions } from '../src/adapters/llm-analyzer.js';
import type { LangChainLLMConfig } from '../src/types.js';

// Generate complete test suite using factory
createLLMAnalyzerTestSuite({
  runtimeName: 'LangChain',
  convertLLMAnalyzerToFunction,
  convertLLMAnalyzersToFunctions,
  agent: simpleNameGeneratorAgent,
  inputSchema: SimpleNameInputSchema,
  outputSchema: SimpleNameOutputSchema,
  llmConfig: {
    model: new ChatOpenAI({ modelName: 'gpt-4o-mini', apiKey: 'test-key' }),
  },
});

// Runtime-specific: LangChain chat models are invoked with a bare prompt string and answer with an
// AIMessage, so the adapter has to reach into `.content` before handing the text back to the agent.
// Returning the message object itself (or stringifying the whole envelope) would still "work" as
// far as the factory suite is concerned, because the factory never lets a call reach the model.
it('invokes the chat model with a bare prompt string and unwraps AIMessage content', async () => {
  const invoke = vi.fn().mockResolvedValue({
    content: '{"name":"Auric Peak","reasoning":"A golden summit"}',
  });

  const generateName = convertLLMAnalyzerToFunction(
    simpleNameGeneratorAgent,
    SimpleNameInputSchema,
    SimpleNameOutputSchema,
    { model: { invoke, modelName: 'gpt-4o-mini' } } as unknown as LangChainLLMConfig,
  );

  const output = await generateName({ adjective: 'Golden', noun: 'Mountain' });

  expect(output).toEqual({ name: 'Auric Peak', reasoning: 'A golden summit' });
  expect(invoke).toHaveBeenCalledTimes(1);
  const prompt: unknown = invoke.mock.calls[0]?.[0];
  expect(typeof prompt).toBe('string');
  expect(prompt).toContain('Noun: "Mountain"');
});

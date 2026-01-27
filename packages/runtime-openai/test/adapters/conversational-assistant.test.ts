import { defineConversationalAssistant } from '@vibe-agent-toolkit/agent-runtime';
import type OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  convertConversationalAssistantToFunction,
  type ConversationalSessionState,
} from '../../src/adapters/conversational-assistant.js';

describe('convertConversationalAssistantToFunction', () => {
  // Constants for duplicated strings
  const TEST_NAME = 'test-chat';
  const TEST_DESCRIPTION = 'Test conversational assistant';
  const TEST_VERSION = '1.0.0';
  const TEST_MODEL = 'gpt-4o-mini';
  const TEST_MODEL_GPT4O = 'gpt-4o';
  const TEST_RESPONSE_HELLO = 'Hello! How can I help you?';

  // Test schemas
  const InputSchema = z.object({
    message: z.string(),
    sessionState: z
      .object({
        context: z.string().optional(),
      })
      .optional(),
  });

  const OutputSchema = z.object({
    reply: z.string(),
    updatedContext: z.string().optional(),
  });

  type Input = z.infer<typeof InputSchema>;
  type Output = z.infer<typeof OutputSchema>;

  // Mock OpenAI client
  let mockClient: OpenAI;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCreate = vi.fn();
    mockClient = {
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    } as unknown as OpenAI;
  });

  /**
   * Factory function to create a test agent with standard behavior
   * Reduces duplication across test cases
   */
  function createTestAgent(systemPrompt?: string, options?: { skipHistoryUpdate?: boolean; customLLMCall?: boolean }) {
    return defineConversationalAssistant<Input, Output>(
      {
        name: TEST_NAME,
        description: TEST_DESCRIPTION,
        version: TEST_VERSION,
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
        ...(systemPrompt && { systemPrompt }),
      },
      async (input, ctx) => {
        if (options?.customLLMCall) {
          // Custom LLM call (for specific tests)
          const response = await ctx.callLLM([{ role: 'user', content: input.message }]);
          return { reply: response };
        }

        ctx.addToHistory('user', input.message);
        const response = await ctx.callLLM(ctx.history);

        if (!options?.skipHistoryUpdate) {
          ctx.addToHistory('assistant', response);
        }

        return { reply: response };
      },
    );
  }

  /**
   * Helper to setup a test with agent, mock response, and converted function
   * Reduces boilerplate in test cases
   */
  function setupTest(options?: {
    systemPrompt?: string;
    agentOptions?: { skipHistoryUpdate?: boolean; customLLMCall?: boolean };
    mockResponse?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }) {
    const agent = createTestAgent(options?.systemPrompt, options?.agentOptions);

    if (options?.mockResponse !== undefined) {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: options.mockResponse } }],
      });
    }

    const chat = convertConversationalAssistantToFunction(agent, InputSchema, OutputSchema, {
      client: mockClient,
      model: options?.model ?? TEST_MODEL,
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
      ...(options?.maxTokens !== undefined && { maxTokens: options.maxTokens }),
    });

    return { agent, chat };
  }

  it('should convert conversational assistant to executable function', async () => {
    // Define test agent
    const agent = createTestAgent('You are a helpful assistant.');

    // Mock OpenAI response
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: TEST_RESPONSE_HELLO } }],
    });

    // Convert to function
    const chat = convertConversationalAssistantToFunction(agent, InputSchema, OutputSchema, {
      client: mockClient,
      model: TEST_MODEL,
    });

    // Execute
    const session: ConversationalSessionState = { history: [] };
    const result = await chat({ message: 'Hi!' }, session);

    expect(result.reply).toBe(TEST_RESPONSE_HELLO);
    expect(session.history).toHaveLength(2); // user + assistant
    expect(session.history[0]).toEqual({ role: 'user', content: 'Hi!' });
    expect(session.history[1]).toEqual({ role: 'assistant', content: TEST_RESPONSE_HELLO });
  });

  it('should include system prompt in LLM calls', async () => {
    const agent = defineConversationalAssistant<Input, Output>(
      {
        name: 'test-chat',
        description: TEST_DESCRIPTION,
        version: '1.0.0',
        inputSchema: InputSchema,
        outputSchema: OutputSchema,
        systemPrompt: 'You are a cat expert.',
      },
      async (input, ctx) => {
        ctx.addToHistory('user', input.message);
        const response = await ctx.callLLM(ctx.history);
        return { reply: response };
      },
    );

    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Meow!' } }],
    });

    const chat = convertConversationalAssistantToFunction(agent, InputSchema, OutputSchema, {
      client: mockClient,
      model: TEST_MODEL,
    });

    const session: ConversationalSessionState = { history: [] };
    await chat({ message: 'Tell me about cats' }, session);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([expect.objectContaining({ role: 'system', content: 'You are a cat expert.' })]),
      }),
    );
  });

  it('should maintain conversation history across turns', async () => {
    const agent = createTestAgent();

    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Sure!' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Persian is calm and fluffy.' } }] });

    const chat = convertConversationalAssistantToFunction(agent, InputSchema, OutputSchema, {
      client: mockClient,
      model: TEST_MODEL,
    });

    const session: ConversationalSessionState = { history: [] };

    // Turn 1
    const result1 = await chat({ message: 'Tell me about cat breeds' }, session);
    expect(result1.reply).toBe('Sure!');
    expect(session.history).toHaveLength(2);

    // Turn 2 (history accumulates)
    const result2 = await chat({ message: 'What about Persian?' }, session);
    expect(result2.reply).toBe('Persian is calm and fluffy.');
    expect(session.history).toHaveLength(4); // 2 user + 2 assistant
  });

  it('should pass temperature and maxTokens to OpenAI', async () => {
    const { chat } = setupTest({
      agentOptions: { customLLMCall: true },
      mockResponse: 'Response',
      model: TEST_MODEL_GPT4O,
      temperature: 0.9,
      maxTokens: 500,
    });

    const session: ConversationalSessionState = { history: [] };
    await chat({ message: 'Test' }, session);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: TEST_MODEL_GPT4O,
        temperature: 0.9,
        max_tokens: 500,
      }),
    );
  });

  it('should validate input and output schemas', async () => {
    const { chat } = setupTest({
      agentOptions: { customLLMCall: true },
      mockResponse: 'Response',
    });

    const session: ConversationalSessionState = { history: [] };

    // Valid input
    await expect(chat({ message: 'Valid message' }, session)).resolves.toEqual({ reply: 'Response' });

    // Invalid input (missing message)
    await expect(chat({} as Input, session)).rejects.toThrow();
  });

  it('should handle empty LLM response gracefully', async () => {
    const { chat } = setupTest({
      agentOptions: { skipHistoryUpdate: true },
      mockResponse: '',
    });

    const session: ConversationalSessionState = { history: [] };
    const result = await chat({ message: 'Test' }, session);

    expect(result.reply).toBe('');
  });

  it('should use custom system prompt parameter over agent manifest', async () => {
    const agent = createTestAgent('Original prompt', { customLLMCall: true });

    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Response' } }],
    });

    const chat = convertConversationalAssistantToFunction(
      agent,
      InputSchema,
      OutputSchema,
      {
        client: mockClient,
        model: TEST_MODEL,
      },
      'Custom system prompt',
    );

    const session: ConversationalSessionState = { history: [] };
    await chat({ message: 'Test' }, session);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([expect.objectContaining({ role: 'system', content: 'Custom system prompt' })]),
      }),
    );
  });

  it('should preserve session state across multiple calls', async () => {
    const agent = createTestAgent();

    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: 'First' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Second' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Third' } }] });

    const chat = convertConversationalAssistantToFunction(agent, InputSchema, OutputSchema, {
      client: mockClient,
      model: TEST_MODEL,
    });

    // Shared session state
    const session: ConversationalSessionState = { history: [] };

    await chat({ message: 'Message 1' }, session);
    expect(session.history).toHaveLength(2);

    await chat({ message: 'Message 2' }, session);
    expect(session.history).toHaveLength(4);

    await chat({ message: 'Message 3' }, session);
    expect(session.history).toHaveLength(6);

    // Verify all messages are preserved
    expect(session.history.map((m) => m.content)).toEqual([
      'Message 1',
      'First',
      'Message 2',
      'Second',
      'Message 3',
      'Third',
    ]);
  });
});

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { defineConversationalAssistant, type ConversationalContext } from '@vibe-agent-toolkit/agent-runtime';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { convertConversationalAssistantToFunction, convertConversationalAssistantsToFunctions } from '../src/adapters/conversational-assistant.js';

// Test constants
const TEST_AGENT_NAME = 'test-assistant';
const TEST_AGENT_DESCRIPTION = 'A test conversational assistant';
const TEST_SYSTEM_PROMPT = 'You are a helpful assistant.';

// Test schemas
const TestInputSchema = z.object({
  message: z.string(),
  sessionState: z.object({
    profile: z.object({
      name: z.string().optional(),
      age: z.number().optional(),
    }),
  }).optional(),
});

const TestOutputSchema = z.object({
  reply: z.string(),
  updatedProfile: z.object({
    name: z.string().optional(),
    age: z.number().optional(),
  }),
});

type TestInput = z.infer<typeof TestInputSchema>;
type TestOutput = z.infer<typeof TestOutputSchema>;

// Create a mock LangChain model
function createMockModel(response: string): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue({
      content: response,
    }),
  } as unknown as BaseChatModel;
}

/**
 * Factory function to create a test agent with custom behavior
 * Reduces duplication across test cases
 */
function createTestAgent(
  name: string,
  handler: (input: TestInput, ctx: unknown) => Promise<TestOutput>,
  systemPrompt?: string,
) {
  return defineConversationalAssistant<TestInput, TestOutput>(
    {
      name,
      description: `${name} agent`,
      version: '1.0.0',
      inputSchema: TestInputSchema,
      outputSchema: TestOutputSchema,
      ...(systemPrompt && { systemPrompt }),
    },
    handler,
  );
}

/**
 * Helper to setup a test with agent and converted function
 * Reduces boilerplate in test cases
 */
function setupTest(
  mockModel: BaseChatModel,
  handler: (input: TestInput, ctx: unknown) => Promise<TestOutput>,
  options?: {
    name?: string;
    systemPrompt?: string;
    temperature?: number;
  },
) {
  const name = options?.name ?? TEST_AGENT_NAME;
  const agent = createTestAgent(name, handler, options?.systemPrompt);

  const chat = convertConversationalAssistantToFunction({
    agent,
    inputSchema: TestInputSchema,
    outputSchema: TestOutputSchema,
    llmConfig: {
      model: mockModel,
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
    },
  });

  return { agent, chat };
}

describe('convertConversationalAssistantToFunction', () => {
  it('should convert conversational assistant agent to executable function', async () => {
    const mockModel = createMockModel('Hello! How can I help you?');
    const { chat } = setupTest(mockModel, standardHandler, {
      systemPrompt: TEST_SYSTEM_PROMPT,
      temperature: 0.7,
    });

    const result = await chat({ message: 'Hello' });

    expect(result.output.reply).toBe('Hello! How can I help you?');
    expect(result.session.history.length).toBeGreaterThan(0);
    expect(mockModel.invoke).toHaveBeenCalled();
  });

  it('should manage conversation history across turns', async () => {
    const mockModel = createMockModel('Response');
    const { chat } = setupTest(mockModel, standardHandler, { systemPrompt: TEST_SYSTEM_PROMPT });

    // First turn
    let result = await chat({ message: 'Turn 1' });
    expect(result.session.history.length).toBe(3); // system + user + assistant

    // Second turn
    result = await chat({ message: 'Turn 2' }, result.session);
    expect(result.session.history.length).toBe(5); // previous 3 + user + assistant
  });

  it('should handle session state across turns', async () => {
    const agent = defineConversationalAssistant<TestInput, TestOutput>(
      {
        name: TEST_AGENT_NAME,
        description: TEST_AGENT_DESCRIPTION,
        version: '1.0.0',
        inputSchema: TestInputSchema,
        outputSchema: TestOutputSchema,
      },
      async (input, ctx) => {
        const currentProfile = input.sessionState?.profile ?? {};

        ctx.addToHistory('user', input.message);
        const response = await ctx.callLLM(ctx.history);
        ctx.addToHistory('assistant', response);

        // Extract name from message
        const nameRegex = /my name is (\w+)/i;
        const nameMatch = nameRegex.exec(input.message);
        const updatedProfile = {
          ...currentProfile,
          ...(nameMatch && { name: nameMatch[1] }),
        };

        return {
          reply: response,
          updatedProfile,
        };
      },
    );

    const mockModel = createMockModel('Nice to meet you!');
    const chat = convertConversationalAssistantToFunction({
      agent,
      inputSchema: TestInputSchema,
      outputSchema: TestOutputSchema,
      llmConfig: {
        model: mockModel,
      },
    });

    const result = await chat({ message: 'My name is Alice' });

    expect(result.output.updatedProfile.name).toBe('Alice');
    expect(result.session.state).toBeDefined();
  });

  it('should add system prompt to first turn', async () => {
    const systemPrompt = 'You are a helpful assistant.';
    const mockModel = createMockModel('Hello!');
    const { chat } = setupTest(mockModel, simpleHandler, { systemPrompt });

    const result = await chat({ message: 'Hi' });

    expect(result.session.history[0].role).toBe('system');
    expect(result.session.history[0].content).toBe(systemPrompt);
  });

  it('should call LangChain model with conversation history', async () => {
    const mockModel = createMockModel('Response');
    const { chat } = setupTest(mockModel, simpleHandler, { systemPrompt: 'You are helpful.' });

    await chat({ message: 'Test' });

    // Model should be called with messages array
    expect(mockModel.invoke).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ content: 'You are helpful.' }),
        expect.objectContaining({ content: 'Test' }),
      ]),
    );
  });

  it('should validate input schema', async () => {
    const agent = defineConversationalAssistant<TestInput, TestOutput>(
      {
        name: TEST_AGENT_NAME,
        description: TEST_AGENT_DESCRIPTION,
        version: '1.0.0',
        inputSchema: TestInputSchema,
        outputSchema: TestOutputSchema,
      },
      async () => ({
        reply: 'test',
        updatedProfile: {},
      }),
    );

    const mockModel = createMockModel('Response');
    const chat = convertConversationalAssistantToFunction({
      agent,
      inputSchema: TestInputSchema,
      outputSchema: TestOutputSchema,
      llmConfig: {
        model: mockModel,
      },
    });

    await expect(chat({ message: 123 as unknown as string })).rejects.toThrow();
  });

  it('should validate output schema', async () => {
    const agent = defineConversationalAssistant<TestInput, TestOutput>(
      {
        name: TEST_AGENT_NAME,
        description: TEST_AGENT_DESCRIPTION,
        version: '1.0.0',
        inputSchema: TestInputSchema,
        outputSchema: TestOutputSchema,
      },
      async () => ({
        reply: 123, // Invalid type
        updatedProfile: {},
      }) as unknown as TestOutput,
    );

    const mockModel = createMockModel('Response');
    const chat = convertConversationalAssistantToFunction({
      agent,
      inputSchema: TestInputSchema,
      outputSchema: TestOutputSchema,
      llmConfig: {
        model: mockModel,
      },
    });

    await expect(chat({ message: 'test' })).rejects.toThrow();
  });
});

/**
 * Standard handler that adds messages to history and returns response
 * Reduces duplication across tests
 */
const standardHandler = async (input: TestInput, ctx: ConversationalContext): Promise<TestOutput> => {
  ctx.addToHistory('user', input.message);
  const response = await ctx.callLLM(ctx.history);
  ctx.addToHistory('assistant', response);

  return {
    reply: response,
    updatedProfile: input.sessionState?.profile ?? {},
  };
};

/**
 * Simple handler that only adds user message and returns response
 * Used for tests that need minimal history management
 */
const simpleHandler = async (input: TestInput, ctx: ConversationalContext): Promise<TestOutput> => {
  ctx.addToHistory('user', input.message);
  const response = await ctx.callLLM(ctx.history);
  return {
    reply: response,
    updatedProfile: {},
  };
};

/**
 * Helper to create a standard conversational agent for batch conversion
 * Reduces duplication in batch conversion tests
 */
function createStandardAgent(name: string) {
  return createTestAgent(name, standardHandler);
}

describe('convertConversationalAssistantsToFunctions', () => {
  it('should batch convert multiple conversational assistants', async () => {
    const agent1 = createStandardAgent('assistant-1');
    const agent2 = createStandardAgent('assistant-2');

    const mockModel = createMockModel('Response');
    const assistants = convertConversationalAssistantsToFunctions(
      {
        first: {
          agent: agent1,
          inputSchema: TestInputSchema,
          outputSchema: TestOutputSchema,
        },
        second: {
          agent: agent2,
          inputSchema: TestInputSchema,
          outputSchema: TestOutputSchema,
        },
      },
      {
        model: mockModel,
      },
    );

    expect(assistants.first).toBeInstanceOf(Function);
    expect(assistants.second).toBeInstanceOf(Function);

    const result1 = await assistants.first({ message: 'Test 1' });
    expect(result1.output.reply).toBe('Response');

    const result2 = await assistants.second({ message: 'Test 2' });
    expect(result2.output.reply).toBe('Response');
  });
});

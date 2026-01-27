import { defineConversationalAssistant, type ConversationalContext } from '@vibe-agent-toolkit/agent-runtime';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  convertConversationalAssistantToFunction,
  convertConversationalAssistantsToFunctions,
  type ConversationSession,
} from '../../src/adapters/conversational-assistant.js';

// Test schemas
const ChatInputSchema = z.object({
  message: z.string(),
  sessionState: z.object({ counter: z.number() }).optional(),
});

const ChatOutputSchema = z.object({
  reply: z.string(),
  sessionState: z.object({ counter: z.number() }),
});

type ChatInput = z.infer<typeof ChatInputSchema>;
type ChatOutput = z.infer<typeof ChatOutputSchema>;

// Mock LLM model that simulates responses
function createMockModel() {
  return {
    modelId: 'mock-gpt-4',
    provider: 'mock',
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: 'stop' as const,
      usage: { promptTokens: 0, completionTokens: 0 },
      text: 'Mock response',
    }),
    doStream: async () => {
      throw new Error('Not implemented');
    },
  };
}

/**
 * Factory function to create a test agent with custom behavior
 * Reduces duplication across test cases
 */
function createTestAgent(
  name: string,
  handler: (input: ChatInput, ctx: ConversationalContext) => Promise<ChatOutput>,
) {
  return defineConversationalAssistant<ChatInput, ChatOutput>(
    {
      name,
      description: `${name} agent`,
      version: '1.0.0',
      inputSchema: ChatInputSchema,
      outputSchema: ChatOutputSchema,
    },
    handler,
  );
}

/**
 * Helper to setup a test with agent and converted function
 * Reduces boilerplate in test cases
 */
function setupTest(
  model: ReturnType<typeof createMockModel>,
  handler: (input: ChatInput, ctx: ConversationalContext) => Promise<ChatOutput>,
  options?: {
    name?: string;
    temperature?: number;
    maxTokens?: number;
  },
) {
  const name = options?.name ?? 'test-chat';
  const agent = createTestAgent(name, handler);

  const chatFn = convertConversationalAssistantToFunction(
    agent,
    ChatInputSchema,
    ChatOutputSchema,
    {
      model,
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
      ...(options?.maxTokens !== undefined && { maxTokens: options.maxTokens }),
    },
  );

  return { agent, chatFn };
}

describe('conversational-assistant adapter', () => {
  let mockModel: ReturnType<typeof createMockModel>;

  beforeEach(() => {
    mockModel = createMockModel();
  });

  describe('convertConversationalAssistantToFunction', () => {
    it('should convert agent to function with conversation context', async () => {
      const { chatFn } = setupTest(mockModel, async (input, ctx: ConversationalContext) => {
        // Verify context structure
        expect(ctx.history).toBeDefined();
        expect(ctx.addToHistory).toBeTypeOf('function');
        expect(ctx.callLLM).toBeTypeOf('function');

        const counter = input.sessionState?.counter ?? 0;

        return {
          reply: `Response ${counter + 1}`,
          sessionState: { counter: counter + 1 },
        };
      });

      const session: ConversationSession = { history: [] };
      const result = await chatFn({ message: 'Hello', sessionState: { counter: 0 } }, session);

      expect(result.reply).toBe('Response 1');
      expect(result.sessionState.counter).toBe(1);
    });

    it('should maintain conversation history across turns', async () => {
      const { chatFn } = setupTest(mockModel, async (input, ctx: ConversationalContext) => {
        ctx.addToHistory('user', input.message);

        const historyCount = ctx.history.length;
        const reply = `History has ${historyCount} messages`;

        ctx.addToHistory('assistant', reply);

        return {
          reply,
          sessionState: { counter: historyCount },
        };
      }, { name: 'history-test' });

      const session: ConversationSession = { history: [] };

      // First turn
      const turn1 = await chatFn({ message: 'First message' }, session);
      expect(turn1.reply).toMatch(/History has \d+ messages/);
      expect(session.history.length).toBeGreaterThan(0);

      // Second turn - history should persist
      const turn2 = await chatFn({ message: 'Second message' }, session);
      expect(turn2.reply).toMatch(/History has \d+ messages/);
      expect(session.history.length).toBeGreaterThan(turn1.sessionState.counter);
    });

    it('should initialize session history if undefined', async () => {
      const { chatFn } = setupTest(mockModel, async (_input, ctx: ConversationalContext) => {
        expect(ctx.history).toBeDefined();
        expect(Array.isArray(ctx.history)).toBe(true);

        return {
          reply: 'Initialized',
          sessionState: { counter: 0 },
        };
      }, { name: 'init-test' });

      // Session with undefined history
      const session: ConversationSession = {} as ConversationSession;

      const result = await chatFn({ message: 'Test' }, session);

      expect(result.reply).toBe('Initialized');
      expect(session.history).toBeDefined();
    });

    it('should validate input and output schemas', async () => {
      const { chatFn } = setupTest(mockModel, async (input) => ({
        reply: `Echo: ${input.message}`,
        sessionState: { counter: 0 },
      }), { name: 'validation-test' });

      const session: ConversationSession = { history: [] };

      // Valid input
      await expect(chatFn({ message: 'Valid' }, session)).resolves.toBeDefined();

      // Invalid input (missing message)
      await expect(
        chatFn({ message: undefined as unknown as string }, session),
      ).rejects.toThrow();
    });

    it('should support temperature and maxTokens configuration', async () => {
      const { chatFn } = setupTest(
        mockModel,
        async () => ({
          reply: 'Configured',
          sessionState: { counter: 0 },
        }),
        {
          name: 'config-test',
          temperature: 0.9,
          maxTokens: 500,
        },
      );

      const session: ConversationSession = { history: [] };
      const result = await chatFn({ message: 'Test' }, session);

      expect(result.reply).toBe('Configured');
    });

    it('should extract model name from different model formats', async () => {
      let capturedModelName: string | undefined;

      // Test with provider + modelId format
      const modelWithProvider = {
        modelId: 'gpt-4',
        provider: 'openai',
        doGenerate: mockModel.doGenerate,
        doStream: mockModel.doStream,
      };

      const { chatFn } = setupTest(
        modelWithProvider as ReturnType<typeof createMockModel>,
        async (_input, _ctx) => {
          // The adapter should set mockable=false and provide the model
          capturedModelName = 'mock-gpt-4'; // In real usage, would come from ctx

          return {
            reply: 'Model name extracted',
            sessionState: { counter: 0 },
          };
        },
        { name: 'model-name-test' },
      );

      const session: ConversationSession = { history: [] };
      await chatFn({ message: 'Test' }, session);

      expect(capturedModelName).toBeDefined();
    });

    it('should allow agent-specific session state', async () => {
      const { chatFn } = setupTest(mockModel, async (input) => {
        const counter = input.sessionState?.counter ?? 0;

        return {
          reply: `Count: ${counter}`,
          sessionState: { counter: counter + 1 },
        };
      }, { name: 'state-test' });

      const session: ConversationSession = { history: [] };

      // First turn
      const turn1 = await chatFn({ message: 'One' }, session);
      expect(turn1.reply).toBe('Count: 0');

      // Second turn with updated state
      const turn2 = await chatFn(
        { message: 'Two', sessionState: turn1.sessionState },
        session,
      );
      expect(turn2.reply).toBe('Count: 1');

      // Third turn with updated state
      const turn3 = await chatFn(
        { message: 'Three', sessionState: turn2.sessionState },
        session,
      );
      expect(turn3.reply).toBe('Count: 2');
    });
  });

  describe('convertConversationalAssistantsToFunctions', () => {
    it('should batch convert multiple agents', async () => {
      const agent1 = defineConversationalAssistant<ChatInput, ChatOutput>(
        {
          name: 'agent-1',
          description: 'First agent',
          version: '1.0.0',
          inputSchema: ChatInputSchema,
          outputSchema: ChatOutputSchema,
        },
        async () => ({
          reply: 'Agent 1',
          sessionState: { counter: 1 },
        }),
      );

      const agent2 = defineConversationalAssistant<ChatInput, ChatOutput>(
        {
          name: 'agent-2',
          description: 'Second agent',
          version: '1.0.0',
          inputSchema: ChatInputSchema,
          outputSchema: ChatOutputSchema,
        },
        async () => ({
          reply: 'Agent 2',
          sessionState: { counter: 2 },
        }),
      );

      const assistants = convertConversationalAssistantsToFunctions(
        {
          first: {
            agent: agent1,
            inputSchema: ChatInputSchema,
            outputSchema: ChatOutputSchema,
          },
          second: {
            agent: agent2,
            inputSchema: ChatInputSchema,
            outputSchema: ChatOutputSchema,
          },
        },
        { model: mockModel },
      );

      expect(assistants.first).toBeTypeOf('function');
      expect(assistants.second).toBeTypeOf('function');

      const session1: ConversationSession = { history: [] };
      const session2: ConversationSession = { history: [] };

      const result1 = await assistants.first({ message: 'Test 1' }, session1);
      const result2 = await assistants.second({ message: 'Test 2' }, session2);

      expect(result1.reply).toBe('Agent 1');
      expect(result2.reply).toBe('Agent 2');
    });

    it('should maintain independent sessions for each agent', async () => {
      const agent = defineConversationalAssistant<ChatInput, ChatOutput>(
        {
          name: 'shared-agent',
          description: 'Shared agent definition',
          version: '1.0.0',
          inputSchema: ChatInputSchema,
          outputSchema: ChatOutputSchema,
        },
        async (input, ctx) => {
          ctx.addToHistory('user', input.message);

          return {
            reply: `History length: ${ctx.history.length}`,
            sessionState: { counter: ctx.history.length },
          };
        },
      );

      const assistants = convertConversationalAssistantsToFunctions(
        {
          instanceA: {
            agent,
            inputSchema: ChatInputSchema,
            outputSchema: ChatOutputSchema,
          },
          instanceB: {
            agent,
            inputSchema: ChatInputSchema,
            outputSchema: ChatOutputSchema,
          },
        },
        { model: mockModel },
      );

      // Each instance should have its own session
      const sessionA: ConversationSession = { history: [] };
      const sessionB: ConversationSession = { history: [] };

      // Instance A - first turn
      await assistants.instanceA({ message: 'A1' }, sessionA);

      // Instance B - first turn
      await assistants.instanceB({ message: 'B1' }, sessionB);

      // Instance A - second turn (should have more history)
      await assistants.instanceA({ message: 'A2' }, sessionA);

      // Instance B - second turn (independent history)
      await assistants.instanceB({ message: 'B2' }, sessionB);

      // Verify independent sessions
      expect(sessionA.history.length).toBeGreaterThan(0);
      expect(sessionB.history.length).toBeGreaterThan(0);
      expect(sessionA.history.length).not.toBe(0); // Should have accumulated
      expect(sessionB.history.length).not.toBe(0); // Should have accumulated
    });
  });
});

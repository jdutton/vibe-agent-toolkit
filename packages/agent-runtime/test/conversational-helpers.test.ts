import { describe, expect, it } from 'vitest';

import { createConversationalContext } from '../src/conversational-helpers.js';
import type { Message } from '../src/types.js';

const TEST_RESPONSE = 'test response';

describe('conversational-helpers', () => {
  describe('createConversationalContext', () => {
    it('should create a conversational context with history and callLLM', () => {
      const history: Message[] = [];
      const mockCallLLM = async (_messages: Message[]) => TEST_RESPONSE;

      const context = createConversationalContext(history, mockCallLLM);

      expect(context.mockable).toBe(false);
      expect(context.history).toBe(history);
      expect(context.callLLM).toBe(mockCallLLM);
      expect(typeof context.addToHistory).toBe('function');
    });

    it('should allow adding messages to history', () => {
      const history: Message[] = [];
      const mockCallLLM = async (_messages: Message[]) => TEST_RESPONSE;

      const context = createConversationalContext(history, mockCallLLM);

      context.addToHistory('user', 'Hello');
      context.addToHistory('assistant', 'Hi there');

      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(history[1]).toEqual({ role: 'assistant', content: 'Hi there' });
    });

    it('should mutate the original history array', () => {
      const history: Message[] = [{ role: 'system', content: 'Initial' }];
      const mockCallLLM = async (_messages: Message[]) => TEST_RESPONSE;

      const context = createConversationalContext(history, mockCallLLM);

      context.addToHistory('user', 'New message');

      // Verify the original array was mutated
      expect(history).toHaveLength(2);
      expect(history[1]).toEqual({ role: 'user', content: 'New message' });
    });
  });
});

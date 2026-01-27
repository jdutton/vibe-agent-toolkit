/**
 * Test: Common helper functions for Claude Agent SDK runtime
 *
 * These tests validate critical message formatting logic that ensures
 * proper communication with the Anthropic API.
 */

import type { Message } from '@vibe-agent-toolkit/agent-runtime';
import { describe, expect, it } from 'vitest';

import { extractTextFromResponse, formatMessagesForAnthropic } from '../../src/adapters/common-helpers.js';

describe('formatMessagesForAnthropic', () => {
  describe('System message handling', () => {
    it('should extract single system message', () => {
      const messages: Message[] = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const result = formatMessagesForAnthropic(messages);

      expect(result.systemPrompt).toBe('You are a helpful assistant');
      expect(result.conversationMessages).toHaveLength(2);
      expect(result.conversationMessages[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(result.conversationMessages[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
    });

    it('should combine multiple system messages with double newlines', () => {
      const messages: Message[] = [
        { role: 'system', content: 'First system prompt' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
        { role: 'system', content: 'Second system prompt' },
        { role: 'user', content: 'How are you?' },
        { role: 'system', content: 'Third system prompt' },
      ];

      const result = formatMessagesForAnthropic(messages);

      // Bug #2: This test would have caught only using the first system message
      expect(result.systemPrompt).toBe('First system prompt\n\nSecond system prompt\n\nThird system prompt');
      expect(result.conversationMessages).toHaveLength(3); // user, assistant, user
    });

    it('should handle messages with no system prompt', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const result = formatMessagesForAnthropic(messages);

      expect(result.systemPrompt).toBeUndefined();
      expect(result.conversationMessages).toHaveLength(2);
    });

    it('should handle only system messages', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System prompt 1' },
        { role: 'system', content: 'System prompt 2' },
      ];

      const result = formatMessagesForAnthropic(messages);

      expect(result.systemPrompt).toBe('System prompt 1\n\nSystem prompt 2');
      expect(result.conversationMessages).toHaveLength(0);
    });
  });

  describe('Conversation message ordering', () => {
    it('should filter out all system messages from conversation', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Message 1' },
        { role: 'system', content: 'Another system' },
        { role: 'assistant', content: 'Response 1' },
        { role: 'system', content: 'Yet another system' },
        { role: 'user', content: 'Message 2' },
      ];

      const result = formatMessagesForAnthropic(messages);

      // All system messages should be removed from conversation
      expect(result.conversationMessages).toHaveLength(3);
      expect(result.conversationMessages[0]).toEqual({ role: 'user', content: 'Message 1' });
      expect(result.conversationMessages[1]).toEqual({ role: 'assistant', content: 'Response 1' });
      expect(result.conversationMessages[2]).toEqual({ role: 'user', content: 'Message 2' });
    });

    it('should preserve user/assistant alternation after filtering system messages', () => {
      const messages: Message[] = [
        { role: 'system', content: 'Gathering prompt' },
        { role: 'user', content: 'Tell me about cats' },
        { role: 'assistant', content: 'Cats are great!' },
        { role: 'system', content: 'Current profile: {}' },
        { role: 'user', content: 'What about dogs?' },
        { role: 'assistant', content: 'Dogs are also great!' },
        { role: 'system', content: 'Extraction prompt' },
      ];

      const result = formatMessagesForAnthropic(messages);

      // Bug #3: System messages interspersed should not break alternation
      // After filtering, should have: user, assistant, user, assistant
      expect(result.conversationMessages).toHaveLength(4);
      expect(result.conversationMessages[0].role).toBe('user');
      expect(result.conversationMessages[1].role).toBe('assistant');
      expect(result.conversationMessages[2].role).toBe('user');
      expect(result.conversationMessages[3].role).toBe('assistant');
    });

    it('should ensure last conversation message is user or assistant, never system', () => {
      // This is the bug scenario: conversation followed by system message
      const messages: Message[] = [
        { role: 'system', content: 'Gathering prompt' },
        { role: 'user', content: 'I live in an apartment' },
        { role: 'assistant', content: 'Got it!' },
        { role: 'system', content: 'Extraction prompt: Return JSON...' },
      ];

      const result = formatMessagesForAnthropic(messages);

      // Bug #3: Last conversational message should be assistant, not empty
      // Claude API requires last message to be user or assistant
      expect(result.conversationMessages.length).toBeGreaterThan(0);
      // eslint-disable-next-line unicorn/prefer-at
      const lastMessage = result.conversationMessages[result.conversationMessages.length - 1];
      expect(lastMessage?.role).toBe('assistant'); // Should be the actual last user/assistant message

      // System message should be in systemPrompt instead
      expect(result.systemPrompt).toContain('Extraction prompt: Return JSON...');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty message array', () => {
      const messages: Message[] = [];

      const result = formatMessagesForAnthropic(messages);

      expect(result.systemPrompt).toBeUndefined();
      expect(result.conversationMessages).toHaveLength(0);
    });

    it('should handle messages with empty content', () => {
      const messages: Message[] = [
        { role: 'system', content: '' },
        { role: 'user', content: '' },
        { role: 'assistant', content: '' },
      ];

      const result = formatMessagesForAnthropic(messages);

      // Empty system message should still be included
      expect(result.systemPrompt).toBe('');
      expect(result.conversationMessages).toHaveLength(2);
    });

    it('should handle consecutive system messages', () => {
      const messages: Message[] = [
        { role: 'system', content: 'First' },
        { role: 'system', content: 'Second' },
        { role: 'system', content: 'Third' },
        { role: 'user', content: 'Hello' },
      ];

      const result = formatMessagesForAnthropic(messages);

      expect(result.systemPrompt).toBe('First\n\nSecond\n\nThird');
      expect(result.conversationMessages).toHaveLength(1);
    });

    it('should preserve message content exactly', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System with\nnewlines\nand  spaces' },
        { role: 'user', content: 'User with\ttabs\tand\nspecial chars: @#$%' },
        { role: 'assistant', content: 'Response\n\nwith\n\nmultiple\n\nnewlines' },
      ];

      const result = formatMessagesForAnthropic(messages);

      expect(result.systemPrompt).toBe('System with\nnewlines\nand  spaces');
      expect(result.conversationMessages[0]?.content).toBe('User with\ttabs\tand\nspecial chars: @#$%');
      expect(result.conversationMessages[1]?.content).toBe('Response\n\nwith\n\nmultiple\n\nnewlines');
    });
  });
});

describe('extractTextFromResponse', () => {
  it('should extract text from text block', () => {
    const response = {
      content: [
        { type: 'text' as const, text: 'Hello, world!' },
      ],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = extractTextFromResponse(response as any);

    expect(result).toBe('Hello, world!');
  });

  it('should return first text block when multiple blocks exist', () => {
    const response = {
      content: [
        { type: 'text' as const, text: 'First block' },
        { type: 'text' as const, text: 'Second block' },
      ],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = extractTextFromResponse(response as any);

    expect(result).toBe('First block');
  });

  it('should return empty string when no text blocks exist', () => {
    const response = {
      content: [
        { type: 'image' as const },
      ],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = extractTextFromResponse(response as any);

    expect(result).toBe('');
  });

  it('should return empty string when content array is empty', () => {
    const response = {
      content: [],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = extractTextFromResponse(response as any);

    // Bug scenario: Claude returns empty content array
    expect(result).toBe('');
  });

  it('should handle missing text field in text block', () => {
    const response = {
      content: [
        { type: 'text' as const },
      ],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = extractTextFromResponse(response as any);

    expect(result).toBe('');
  });
});

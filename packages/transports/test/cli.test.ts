/**
 * Tests for CLI transport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { CLITransport } from '../src/cli.js';
import type { ConversationalFunction, Session } from '../src/types.js';

describe('CLITransport', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockFn: ConversationalFunction<string, string, any>;
  let transport: CLITransport;

  beforeEach(() => {
    // Mock conversational function that echoes input
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockFn = vi.fn(async (input: string, session: Session<any>) => {
      const newHistory = [
        ...session.history,
        { role: 'user' as const, content: input },
        { role: 'assistant' as const, content: `Echo: ${input}` },
      ];
      return {
        output: `Echo: ${input}`,
        session: { ...session, history: newHistory },
      };
    });
  });

  afterEach(async () => {
    if (transport) {
      await transport.stop();
    }
  });

  it('should create transport with default options', () => {
    transport = new CLITransport({ fn: mockFn });
    expect(transport).toBeDefined();
  });

  it('should create transport with custom options', () => {
    transport = new CLITransport({
      fn: mockFn,
      initialSession: { history: [], state: { count: 0 } },
      colors: false,
      showState: true,
      prompt: 'User: ',
      assistantPrefix: 'Bot: ',
    });
    expect(transport).toBeDefined();
  });

  it('should handle start and stop', async () => {
    transport = new CLITransport({ fn: mockFn });

    // Note: We can't fully test readline interaction without mocking stdin/stdout
    // These tests verify the interface contracts
    expect(transport.start).toBeDefined();
    expect(transport.stop).toBeDefined();

    // Stop should be idempotent
    await transport.stop();
    await transport.stop();
  });

  it('should accept initial session state', () => {
    const initialSession: Session<{ count: number }> = {
      history: [{ role: 'system', content: 'System message' }],
      state: { count: 42 },
    };

    transport = new CLITransport({
      fn: mockFn,
      initialSession,
    });

    expect(transport).toBeDefined();
  });

  it('should support no colors mode', () => {
    transport = new CLITransport({
      fn: mockFn,
      colors: false,
    });

    expect(transport).toBeDefined();
  });
});

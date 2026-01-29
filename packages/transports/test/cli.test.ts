/**
 * Tests for CLI transport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { CLITransport } from '../src/cli.js';
import type { ConversationalFunction } from '../src/types.js';

describe('CLITransport', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockFn: ConversationalFunction<string, string, any>;
  let transport: CLITransport;

  beforeEach(() => {
    // Mock conversational function that echoes input
    mockFn = vi.fn(async (input: string, _context) => {
      return `Echo: ${input}`;
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
      sessionId: 'test-session',
      initialHistory: [],
      initialState: { count: 0 },
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
    transport = new CLITransport({
      fn: mockFn,
      initialHistory: [{ role: 'system', content: 'System message' }],
      initialState: { count: 42 },
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

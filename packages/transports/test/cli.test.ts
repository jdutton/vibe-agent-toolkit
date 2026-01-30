/**
 * Tests for CLI transport.
 */

import type { RuntimeSession, SessionStore } from '@vibe-agent-toolkit/agent-runtime';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { CLITransport } from '../src/cli.js';
import type { ConversationalFunction } from '../src/types.js';

// Test constants
const TEST_SESSION_ID = 'test-session';

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
      sessionId: TEST_SESSION_ID,
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

describe('CLITransport with SessionStore', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockFn: ConversationalFunction<string, string, any>;
  let transport: CLITransport;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Mock conversational function
    mockFn = vi.fn(async (input: string, _context) => {
      return `Echo: ${input}`;
    });

    // Spy on console to suppress output during tests
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock process.exit to prevent actual exits during tests
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    // Mock process.stdin and process.stdout to prevent readline from actually starting
    vi.spyOn(process.stdin, 'on').mockImplementation(() => process.stdin);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    if (transport) {
      await transport.stop();
    }
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  /**
   * Helper to create a mock session store
   */
  function createMockStore<TState>(
    options: Partial<SessionStore<TState>> = {}
  ): SessionStore<TState> {
    return {
      create: vi.fn().mockResolvedValue('mock-session-id'),
      load: vi.fn().mockRejectedValue(new Error('Not found')),
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue([]),
      cleanup: vi.fn().mockResolvedValue(0),
      ...options,
    };
  }

  /**
   * Helper to create a mock session
   */
  function createMockSession<TState>(
    sessionId: string,
    history: RuntimeSession<TState>['history'],
    state: TState
  ): RuntimeSession<TState> {
    return {
      id: sessionId,
      history,
      state,
      metadata: {
        createdAt: new Date(),
        lastAccessedAt: new Date(),
      },
    };
  }

  /**
   * Helper to create a transport with a new session (not found in store)
   */
  async function createTransportWithNewSession<TState>(
    initialState: TState
  ): Promise<{ transport: CLITransport<TState>; mockStore: SessionStore<TState> }> {
    const mockStore = createMockStore({
      exists: vi.fn().mockResolvedValue(false),
      create: vi.fn().mockResolvedValue(TEST_SESSION_ID),
      load: vi.fn().mockResolvedValue(
        createMockSession(TEST_SESSION_ID, [], initialState)
      ),
    });

    const newTransport = new CLITransport({
      fn: mockFn,
      sessionId: TEST_SESSION_ID,
      sessionStore: mockStore,
      initialHistory: [],
      initialState,
    });

    return { transport: newTransport, mockStore };
  }

  describe('High Priority #1: Session loading on start()', () => {
    it('should load existing session from store on start()', async () => {
      const existingSession = createMockSession(TEST_SESSION_ID, [
        { role: 'user', content: 'Previous message' },
        { role: 'assistant', content: 'Previous response' },
      ], { count: 5 });

      const mockStore = createMockStore({
        load: vi.fn().mockResolvedValue(existingSession),
        exists: vi.fn().mockResolvedValue(true),
      });

      transport = new CLITransport({
        fn: mockFn,
        sessionId: TEST_SESSION_ID,
        sessionStore: mockStore,
        initialHistory: [],
        initialState: { count: 0 },
      });

      await transport.start();

      // Verify session was loaded
      expect(mockStore.load).toHaveBeenCalledWith(TEST_SESSION_ID);
      expect(mockStore.load).toHaveBeenCalledTimes(1);

      // Verify console message about resumed session
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Resumed session: test-session')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('2 messages in history')
      );
    });

    it('should only load session once (idempotent)', async () => {
      const existingSession = createMockSession(TEST_SESSION_ID, [], { count: 1 });

      const mockStore = createMockStore({
        load: vi.fn().mockResolvedValue(existingSession),
      });

      transport = new CLITransport({
        fn: mockFn,
        sessionId: TEST_SESSION_ID,
        sessionStore: mockStore,
      });

      await transport.start();

      // Call start again (shouldn't reload)
      await transport.start();

      // Should only load once
      expect(mockStore.load).toHaveBeenCalledTimes(1);
    });
  });

  describe('High Priority #2: Fallback to initial state', () => {
    it('should fall back to initial state when session not found', async () => {
      const mockStore = createMockStore({
        load: vi.fn().mockRejectedValue(new Error('Session not found')),
        exists: vi.fn().mockResolvedValue(false),
      });

      transport = new CLITransport({
        fn: mockFn,
        sessionId: 'new-session',
        sessionStore: mockStore,
        initialHistory: [{ role: 'system', content: 'Welcome' }],
        initialState: { count: 0 },
      });

      // Should not throw
      await expect(transport.start()).resolves.not.toThrow();

      // Verify load was attempted
      expect(mockStore.load).toHaveBeenCalledWith('new-session');

      // Should not show "Resumed session" message
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Resumed session')
      );
    });

    it('should handle various error types gracefully', async () => {
      const errorTypes = [
        new Error('Session not found'),
        new Error('File not found'),
        new Error('Permission denied'),
        { code: 'ENOENT' } as NodeJS.ErrnoException,
      ];

      for (const error of errorTypes) {
        const mockStore = createMockStore({
          load: vi.fn().mockRejectedValue(error),
        });

        const testTransport = new CLITransport({
          fn: mockFn,
          sessionId: 'test',
          sessionStore: mockStore,
        });

        await expect(testTransport.start()).resolves.not.toThrow();
        await testTransport.stop();
      }
    });
  });

  describe('High Priority #3: Session saving on stop()', () => {
    it('should save session on stop()', async () => {
      const { transport: newTransport, mockStore } = await createTransportWithNewSession({ count: 0 });
      transport = newTransport;

      await transport.start();
      await transport.stop();

      // Should create new session and save it
      expect(mockStore.create).toHaveBeenCalledWith({ count: 0 });
      expect(mockStore.save).toHaveBeenCalled();
    });

    it('should update existing session on stop()', async () => {
      const existingSession = createMockSession(TEST_SESSION_ID, [
        { role: 'user', content: 'Hello' },
      ], { count: 1 });

      const mockStore = createMockStore({
        exists: vi.fn().mockResolvedValue(true),
        load: vi.fn().mockResolvedValue(existingSession),
      });

      transport = new CLITransport({
        fn: mockFn,
        sessionId: TEST_SESSION_ID,
        sessionStore: mockStore,
      });

      await transport.start();
      await transport.stop();

      // Should load existing session and save updates
      expect(mockStore.load).toHaveBeenCalledWith(TEST_SESSION_ID);
      expect(mockStore.save).toHaveBeenCalled();

      // Verify saved session preserves data
      const savedSession = (mockStore.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as RuntimeSession<unknown>;
      expect(savedSession).toBeDefined();
      expect(savedSession.id).toBe(TEST_SESSION_ID);
      expect(savedSession.metadata).toBeDefined();
    });

    it('should handle multiple stops safely', async () => {
      const { transport: newTransport, mockStore } = await createTransportWithNewSession({});
      transport = newTransport;

      await transport.start();
      await transport.stop();

      const firstStopCalls = (mockStore.save as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(firstStopCalls).toBeGreaterThan(0);

      // Second stop should not crash (idempotent safety)
      await expect(transport.stop()).resolves.not.toThrow();

      // May or may not save again (rl already closed), but shouldn't crash
      const totalCalls = (mockStore.save as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(totalCalls).toBeGreaterThanOrEqual(firstStopCalls);
    });
  });

  describe('High Priority #4: Error handling', () => {
    it('should handle session store errors gracefully on start', async () => {
      const mockStore = createMockStore({
        load: vi.fn().mockRejectedValue(new Error('Database connection failed')),
      });

      transport = new CLITransport({
        fn: mockFn,
        sessionId: TEST_SESSION_ID,
        sessionStore: mockStore,
      });

      // Should not throw - logs warning instead
      await expect(transport.start()).resolves.not.toThrow();

      // Should still be functional (no session data, but doesn't crash)
      expect(transport).toBeDefined();
    });

    it('should handle session store errors gracefully on stop', async () => {
      const { transport: newTransport, mockStore } = await createTransportWithNewSession({});
      transport = newTransport;

      // Override save to throw error
      (mockStore.save as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Disk full'));

      await transport.start();

      // Should not throw - logs warning instead
      await expect(transport.stop()).resolves.not.toThrow();

      // Should log error
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save session')
      );
    });

    it('should handle exists() errors gracefully', async () => {
      const mockStore = createMockStore({
        exists: vi.fn().mockRejectedValue(new Error('Permission denied')),
      });

      transport = new CLITransport({
        fn: mockFn,
        sessionId: TEST_SESSION_ID,
        sessionStore: mockStore,
      });

      await transport.start();

      // Should not throw on stop even if exists() fails
      await expect(transport.stop()).resolves.not.toThrow();
    });

    it('should work without session store (backward compatibility)', async () => {
      transport = new CLITransport({
        fn: mockFn,
        sessionId: TEST_SESSION_ID,
        // No sessionStore provided
        initialHistory: [{ role: 'user', content: 'Hi' }],
        initialState: { count: 42 },
      });

      // Should work fine without session store
      await expect(transport.start()).resolves.not.toThrow();
      await expect(transport.stop()).resolves.not.toThrow();
    });

    it('should handle missing sessionId gracefully', async () => {
      const mockStore = createMockStore({
        load: vi.fn().mockRejectedValue(new Error('Not found')),
      });

      transport = new CLITransport({
        fn: mockFn,
        // sessionId will default to 'cli-singleton'
        sessionStore: mockStore,
      });

      await expect(transport.start()).resolves.not.toThrow();
      await expect(transport.stop()).resolves.not.toThrow();

      // Should use default session ID
      expect(mockStore.load).toHaveBeenCalledWith('cli-singleton');
    });
  });
});

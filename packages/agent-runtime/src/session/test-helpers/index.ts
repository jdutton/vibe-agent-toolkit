/**
 * Shared test utilities for session store testing.
 *
 * Eliminates duplication between MemorySessionStore and FileSessionStore tests.
 */

import { describe, expect, it } from 'vitest';

import type { SessionStore } from '../types.js';

/**
 * Test suite state for session store tests
 */
export interface SessionStoreTestSuite<TState> {
  store: SessionStore<TState>;
  setup: () => Promise<void>;
  teardown: () => Promise<void>;
}

/**
 * Shared constants for tests
 */
export const TEST_CONSTANTS = {
  NON_EXISTENT_SESSION_ID: 'non-existent',
  INVALID_SESSION_MSG: 'Invalid session ID',
  SHORT_TTL: 10, // milliseconds
  MEDIUM_TTL: 1000, // 1 second
  LONG_TTL: 60000, // 1 minute
} as const;

/**
 * Common test cases for create() method
 */
export function testCreateMethod<TState>(
  getSuite: () => SessionStoreTestSuite<TState>,
  expectedInitialState: TState
): Record<string, () => Promise<void>> {
  return {
    'should create a new session with default initial state': async () => {
      const { store } = getSuite();
      const sessionId = await store.create();

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');

      const session = await store.load(sessionId);
      expect(session.id).toBe(sessionId);
      expect(session.history).toEqual([]);
      expect(session.state).toEqual(expectedInitialState);
      expect(session.metadata.createdAt).toBeInstanceOf(Date);
      expect(session.metadata.lastAccessedAt).toBeInstanceOf(Date);
    },

    'should create a new session with custom initial state': async () => {
      const { store } = getSuite();
      const customState = { count: 10 } as unknown as TState;
      const sessionId = await store.create(customState);

      const session = await store.load(sessionId);
      expect(session.state).toEqual(customState);
    },
  };
}

/**
 * Common test cases for load() method
 */
export function testLoadMethod<TState>(
  getSuite: () => SessionStoreTestSuite<TState>,
  SessionNotFoundError: new (id: string) => Error
): Record<string, () => Promise<void>> {
  return {
    'should load existing session': async () => {
      const { store } = getSuite();
      const sessionId = await store.create();
      const session = await store.load(sessionId);

      expect(session.id).toBe(sessionId);
    },

    'should throw SessionNotFoundError for non-existent session': async () => {
      const { store } = getSuite();
      await expect(store.load(TEST_CONSTANTS.NON_EXISTENT_SESSION_ID)).rejects.toThrow(
        SessionNotFoundError
      );
    },

    'should update lastAccessedAt on load': async () => {
      const { store } = getSuite();
      const sessionId = await store.create();
      const session1 = await store.load(sessionId);
      const timestamp1 = session1.metadata.lastAccessedAt.getTime();

      // Wait enough time to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 50));

      const session2 = await store.load(sessionId);
      const timestamp2 = session2.metadata.lastAccessedAt.getTime();

      expect(timestamp2).toBeGreaterThan(timestamp1);
    },
  };
}

/**
 * Common test cases for save() method
 */
export function testSaveMethod<TState extends { count: number }>(
  getSuite: () => SessionStoreTestSuite<TState>
): Record<string, () => Promise<void>> {
  return {
    'should save session changes': async () => {
      const { store } = getSuite();
      const sessionId = await store.create();
      const session = await store.load(sessionId);

      session.state.count = 5;
      session.history.push({ role: 'user', content: 'Hello' });

      await store.save(session);

      const loaded = await store.load(sessionId);
      expect(loaded.state.count).toBe(5);
      expect(loaded.history).toHaveLength(1);
    },
  };
}

/**
 * Common test cases for delete() method
 */
export function testDeleteMethod<TState>(
  getSuite: () => SessionStoreTestSuite<TState>,
  SessionNotFoundError: new (id: string) => Error
): Record<string, () => Promise<void>> {
  return {
    'should delete existing session': async () => {
      const { store } = getSuite();
      const sessionId = await store.create();
      await store.delete(sessionId);

      await expect(store.load(sessionId)).rejects.toThrow(SessionNotFoundError);
    },

    'should not throw error when deleting non-existent session': async () => {
      const { store } = getSuite();
      await expect(store.delete(TEST_CONSTANTS.NON_EXISTENT_SESSION_ID)).resolves.toBeUndefined();
    },
  };
}

/**
 * Common test cases for exists() method
 */
export function testExistsMethod<TState>(
  getSuite: () => SessionStoreTestSuite<TState>
): Record<string, () => Promise<void>> {
  return {
    'should return true for existing session': async () => {
      const { store } = getSuite();
      const sessionId = await store.create();
      expect(await store.exists(sessionId)).toBe(true);
    },

    'should return false for non-existent session': async () => {
      const { store } = getSuite();
      expect(await store.exists(TEST_CONSTANTS.NON_EXISTENT_SESSION_ID)).toBe(false);
    },
  };
}

/**
 * Common test cases for list() method
 */
export function testListMethod<TState>(
  getSuite: () => SessionStoreTestSuite<TState>
): Record<string, () => Promise<void>> {
  return {
    'should return empty array for empty store': async () => {
      const { store } = getSuite();
      const sessionIds = await store.list();
      expect(sessionIds).toEqual([]);
    },

    'should list all session IDs': async () => {
      const { store } = getSuite();
      const id1 = await store.create();
      const id2 = await store.create();
      const id3 = await store.create();

      const sessionIds = await store.list();
      expect(sessionIds).toHaveLength(3);
      expect(sessionIds).toContain(id1);
      expect(sessionIds).toContain(id2);
      expect(sessionIds).toContain(id3);
    },
  };
}

/**
 * Helper to register test cases from a test method
 */
export function registerTests(tests: Record<string, () => Promise<void>>): void {
  for (const [name, testFn] of Object.entries(tests)) {
    it(name, testFn);
  }
}

/**
 * Register all common test suites for a SessionStore implementation
 */
export function registerCommonSessionStoreTests<TState extends { count: number }>(
  getSuite: () => SessionStoreTestSuite<TState>,
  _expectedInitialState: TState,
  SessionNotFoundError: new (id: string) => Error
): void {
  describe('delete', () => {
    registerTests(testDeleteMethod(getSuite, SessionNotFoundError));
  });

  describe('exists', () => {
    registerTests(testExistsMethod(getSuite));
  });

  describe('list', () => {
    registerTests(testListMethod(getSuite));
  });
}

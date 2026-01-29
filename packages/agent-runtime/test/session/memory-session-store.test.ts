import { describe, expect, it, beforeEach } from 'vitest';

import { MemorySessionStore, SessionNotFoundError } from '../../src/session/index.js';
import {
  registerCommonSessionStoreTests,
  registerTests,
  testCreateMethod,
  testLoadMethod,
  testSaveMethod,
  TEST_CONSTANTS,
  type SessionStoreTestSuite,
} from '../../src/session/test-helpers/index.js';

describe('MemorySessionStore', () => {
  const suite: SessionStoreTestSuite<{ count: number }> = {
    store: null as unknown as MemorySessionStore<{ count: number }>,
    setup: async () => {
      suite.store = new MemorySessionStore<{ count: number }>({
        createInitialState: () => ({ count: 0 }),
      });
    },
    teardown: async () => {
      // Memory store doesn't need cleanup
    },
  };

  beforeEach(async () => {
    await suite.setup();
  });

  const getSuite = () => suite;

  describe('create', () => {
    registerTests(testCreateMethod(getSuite, { count: 0 }));

    it('should create session with TTL when configured', async () => {
      const storeWithTTL = new MemorySessionStore<{ count: number }>({
        ttl: TEST_CONSTANTS.LONG_TTL,
      });

      const sessionId = await storeWithTTL.create();
      const session = await storeWithTTL.load(sessionId);

      expect(session.metadata.expiresAt).toBeInstanceOf(Date);
      expect(session.metadata.expiresAt).toBeDefined();
      if (session.metadata.expiresAt) {
        expect(session.metadata.expiresAt.getTime()).toBeGreaterThan(Date.now());
      }
    });

    it('should use custom ID generator when provided', async () => {
      const CUSTOM_ID_PREFIX = 'custom-';
      let counter = 0;
      const customStore = new MemorySessionStore({
        generateId: () => `${CUSTOM_ID_PREFIX}${++counter}`,
      });

      const sessionId1 = await customStore.create();
      const sessionId2 = await customStore.create();

      expect(sessionId1).toBe(`${CUSTOM_ID_PREFIX}1`);
      expect(sessionId2).toBe(`${CUSTOM_ID_PREFIX}2`);
    });
  });

  describe('load', () => {
    registerTests(testLoadMethod(getSuite, SessionNotFoundError));

    it('should extend TTL on load when configured', async () => {
      const storeWithTTL = new MemorySessionStore<{ count: number }>({
        ttl: TEST_CONSTANTS.LONG_TTL,
      });

      const sessionId = await storeWithTTL.create();
      const session1 = await storeWithTTL.load(sessionId);
      expect(session1.metadata.expiresAt).toBeDefined();
      if (!session1.metadata.expiresAt) {
        throw new Error('Expected expiresAt to be defined');
      }
      const timestamp1 = session1.metadata.expiresAt.getTime();

      // Wait enough time to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 50));

      const session2 = await storeWithTTL.load(sessionId);
      expect(session2.metadata.expiresAt).toBeDefined();
      if (!session2.metadata.expiresAt) {
        throw new Error('Expected expiresAt to be defined');
      }
      const timestamp2 = session2.metadata.expiresAt.getTime();

      expect(timestamp2).toBeGreaterThan(timestamp1);
    });

    it('should throw SessionNotFoundError for expired session', async () => {
      const storeWithTTL = new MemorySessionStore<{ count: number }>({
        ttl: TEST_CONSTANTS.SHORT_TTL,
      });

      const sessionId = await storeWithTTL.create();

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 20));

      await expect(storeWithTTL.load(sessionId)).rejects.toThrow(SessionNotFoundError);
    });
  });

  describe('save', () => {
    registerTests(testSaveMethod(getSuite));

    it('should update lastAccessedAt on save', async () => {
      const sessionId = await suite.store.create();
      const session = await suite.store.load(sessionId);
      const originalAccessTime = session.metadata.lastAccessedAt;

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      await suite.store.save(session);

      const loaded = await suite.store.load(sessionId);
      expect(loaded.metadata.lastAccessedAt.getTime()).toBeGreaterThan(
        originalAccessTime.getTime()
      );
    });
  });

  registerCommonSessionStoreTests(getSuite, { count: 0 }, SessionNotFoundError);

  describe('cleanup', () => {
    it('should return 0 when no expired sessions', async () => {
      await suite.store.create();
      await suite.store.create();

      const cleaned = await suite.store.cleanup();
      expect(cleaned).toBe(0);
    });

    it('should remove expired sessions', async () => {
      const storeWithTTL = new MemorySessionStore<{ count: number }>({
        ttl: TEST_CONSTANTS.SHORT_TTL,
      });

      const id1 = await storeWithTTL.create();
      const id2 = await storeWithTTL.create();

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 20));

      const cleaned = await storeWithTTL.cleanup();
      expect(cleaned).toBe(2);

      await expect(storeWithTTL.load(id1)).rejects.toThrow(SessionNotFoundError);
      await expect(storeWithTTL.load(id2)).rejects.toThrow(SessionNotFoundError);
    });

    it('should only remove expired sessions, not active ones', async () => {
      const storeWithTTL = new MemorySessionStore<{ count: number }>({
        ttl: TEST_CONSTANTS.MEDIUM_TTL,
      });

      await storeWithTTL.create();
      await storeWithTTL.create();

      // Wait a bit but not enough to expire
      await new Promise(resolve => setTimeout(resolve, 10));

      const cleaned = await storeWithTTL.cleanup();
      expect(cleaned).toBe(0);

      const sessionIds = await storeWithTTL.list();
      expect(sessionIds).toHaveLength(2);
    });
  });
});

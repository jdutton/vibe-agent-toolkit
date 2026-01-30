import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { SessionNotFoundError } from '@vibe-agent-toolkit/agent-runtime';
import {
  registerCommonSessionStoreTests,
  registerTests,
  testCreateMethod,
  testLoadMethod,
  testSaveMethod,
  TEST_CONSTANTS,
  type SessionStoreTestSuite,
} from '@vibe-agent-toolkit/agent-runtime/session/test-helpers';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { FileSessionStore } from '../../src/session/file-session-store.js';

describe('FileSessionStore', () => {
  let tempDir: string;

  const suite: SessionStoreTestSuite<{ count: number }> = {
    store: null as unknown as FileSessionStore<{ count: number }>,
    setup: async () => {
      tempDir = await mkdtemp(join(normalizedTmpdir(), 'file-session-store-test-'));
      suite.store = new FileSessionStore<{ count: number }>({
        baseDir: tempDir,
        createInitialState: () => ({ count: 0 }),
      });
    },
    teardown: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };

  beforeEach(async () => {
    await suite.setup();
  });

  afterEach(async () => {
    await suite.teardown();
  });

  const getSuite = () => suite;

  describe('create', () => {
    registerTests(testCreateMethod(getSuite, { count: 0 }));

    it('should persist session to file system', async () => {
      const sessionId = await suite.store.create();

      // Create new store instance pointing to same directory
      const store2 = new FileSessionStore<{ count: number }>({
        baseDir: tempDir,
      });

      const session = await store2.load(sessionId);
      expect(session.id).toBe(sessionId);
    });
  });

  describe('load', () => {
    registerTests(testLoadMethod(getSuite, SessionNotFoundError));
  });

  describe('save', () => {
    registerTests(testSaveMethod(getSuite));

    it('should be accessible from new store instance', async () => {
      const sessionId = await suite.store.create();
      const session = await suite.store.load(sessionId);
      session.state.count = 42;
      await suite.store.save(session);

      // Create new store instance
      const store2 = new FileSessionStore<{ count: number }>({
        baseDir: tempDir,
      });

      const loaded = await store2.load(sessionId);
      expect(loaded.state.count).toBe(42);
    });
  });

  registerCommonSessionStoreTests(getSuite, { count: 0 }, SessionNotFoundError);

  describe('session ID validation', () => {
    it('should reject session IDs with path separators', async () => {
      await expect(suite.store.load('../etc/passwd')).rejects.toThrow(TEST_CONSTANTS.INVALID_SESSION_MSG);
      await expect(suite.store.load('foo/bar')).rejects.toThrow(TEST_CONSTANTS.INVALID_SESSION_MSG);
      await expect(suite.store.load(String.raw`foo\bar`)).rejects.toThrow(
        TEST_CONSTANTS.INVALID_SESSION_MSG
      );
    });

    it('should reject empty session IDs', async () => {
      await expect(suite.store.load('')).rejects.toThrow(TEST_CONSTANTS.INVALID_SESSION_MSG);
    });

    it('should reject very long session IDs', async () => {
      const longId = 'a'.repeat(256);
      await expect(suite.store.load(longId)).rejects.toThrow(TEST_CONSTANTS.INVALID_SESSION_MSG);
    });
  });

  describe('delete', () => {
    it('should not throw on ENOENT (already deleted)', async () => {
      // Delete non-existent session should not throw
      await expect(suite.store.delete('non-existent-session')).resolves.not.toThrow();
    });
  });

  describe('exists', () => {
    it('should return true for existing sessions', async () => {
      const sessionId = await suite.store.create();
      expect(await suite.store.exists(sessionId)).toBe(true);
    });

    it('should return false for non-existent sessions', async () => {
      expect(await suite.store.exists('non-existent')).toBe(false);
    });
  });

  describe('list', () => {
    it('should return empty array when base directory does not exist', async () => {
      const nonExistentDir = join(tempDir, 'non-existent-subdir');
      const store = new FileSessionStore<{ count: number }>({
        baseDir: nonExistentDir,
      });

      expect(await store.list()).toEqual([]);
    });

    it('should return all session IDs', async () => {
      const id1 = await suite.store.create();
      const id2 = await suite.store.create();

      const sessions = await suite.store.list();
      expect(sessions).toContain(id1);
      expect(sessions).toContain(id2);
      expect(sessions.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getCheckpointDir', () => {
    it('should return checkpoint directory path', () => {
      const sessionId = 'test-session';
      const checkpointDir = (suite.store as FileSessionStore<{ count: number }>).getCheckpointDir(sessionId);

      expect(checkpointDir).toContain(sessionId);
      expect(checkpointDir).toContain('checkpoints');
    });

    it('should validate session ID', () => {
      expect(() => (suite.store as FileSessionStore<{ count: number }>).getCheckpointDir('../etc/passwd')).toThrow(
        TEST_CONSTANTS.INVALID_SESSION_MSG
      );
    });
  });
});

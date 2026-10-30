/**
 * The supervisor's `exit` guard, run for real against a progress directory the OS will not remove.
 *
 * The guard runs on the way OUT of the supervising process — `process.exit` runs no `finally`, and
 * no report will be published after it — so a directory it could not remove is said on stderr or
 * nowhere. Here the guard is installed on a stand-in child and its `exit` listener invoked
 * directly: it must kill the child, and name the leftover directory on stderr.
 *
 * That the guard fires at all when the real binary ends is
 * `checks-supervisor-orphan.system.test.ts`.
 */

import { EventEmitter } from 'node:events';
import { chmodSync, existsSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it, vi } from 'vitest';

import { __internal } from '../../src/commands/resources/check-supervisor.js';
import { cleanupTestTempDir, createTestTempDir, writeFileTree } from '../system/test-common.js';

/** A stand-in for a spawned child: the fields the guard reads, and `close`. */
class StandInChild extends EventEmitter {
  readonly pid = 4242;
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly kill = vi.fn(() => true);
}

describe('the supervisor\'s exit guard', () => {
  it.skipIf(CANNOT_DENY_READS)('kills the child and names, on stderr, a progress directory the OS would not remove', () => {
    const dir = createTestTempDir('vat-check-');
    writeFileTree(dir, { 'progress.jsonl': '', 'locked/x.txt': 'x' });
    const locked = safePath.join(dir, 'locked');
    chmodSync(locked, 0o555);
    const child = new StandInChild();
    const before = new Set(process.listeners('exit'));
    const release = __internal.guardSupervision(
      child as unknown as Parameters<typeof __internal.guardSupervision>[0],
      safePath.join(dir, 'progress.jsonl'),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const onExit = process.listeners('exit').find((listener) => !before.has(listener));
      expect(onExit).toBeDefined();

      onExit?.(0);

      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(stderr.mock.calls.map(([text]) => String(text)).join('')).toContain(dir);
      expect(existsSync(safePath.join(locked, 'x.txt'))).toBe(true);
    } finally {
      stderr.mockRestore();
      child.exitCode = 0;
      child.emit('close', 0, null);
      release();
      chmodSync(locked, 0o755);
      cleanupTestTempDir(dir);
    }
  });
});

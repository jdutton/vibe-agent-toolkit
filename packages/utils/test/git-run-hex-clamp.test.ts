/**
 * `runGitBytes` never throws: hex doubles the string the spawn builds, so a `maxBuffer` past half
 * the engine's string limit would let the spawn throw instead of failing the call. The clamp is
 * observed at the spawn: what `executeGitCommand` is handed.
 */

import { constants } from 'node:buffer';

import { executeGitCommand } from '@vibe-validate/git';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runGitBytes } from '../src/git-run.js';

vi.mock('@vibe-validate/git', () => ({
  executeGitCommand: vi.fn(() => ({ success: true, exitCode: 0, stdout: '', stderr: '' })),
}));

const spawned = vi.mocked(executeGitCommand);

/** The `maxBuffer` the one spawn was handed. */
function spawnedMaxBuffer(): number | undefined {
  return spawned.mock.calls[0]?.[1]?.maxBuffer;
}

describe('runGitBytes maxBuffer', () => {
  afterEach(() => {
    spawned.mockClear();
  });

  it('clamps a maxBuffer past half the string limit, so the hex string can never overflow it', () => {
    runGitBytes(['cat-file', '--batch'], { maxBuffer: constants.MAX_STRING_LENGTH });
    const handed = spawnedMaxBuffer() ?? Number.POSITIVE_INFINITY;
    expect(handed * 2).toBeLessThan(constants.MAX_STRING_LENGTH);
  });

  it('hands a maxBuffer under the clamp over as it is', () => {
    runGitBytes(['cat-file', '--batch'], { maxBuffer: 1024 });
    expect(spawnedMaxBuffer()).toBe(1024);
  });
});

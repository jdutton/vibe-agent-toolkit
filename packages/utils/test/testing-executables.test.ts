import { accessSync, constants } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isAbsolutePath } from '../src/path-core.js';
import { NODE_EXECUTABLE, gitExecutable, resolveExecutable } from '../src/testing/executables.js';

describe('resolveExecutable', () => {
  it('returns an absolute, executable path for a binary on PATH', () => {
    const git = resolveExecutable('git');
    expect(isAbsolutePath(git)).toBe(true);
    expect(() => accessSync(git, constants.X_OK)).not.toThrow();
  });

  it('names the missing binary and the PATH it searched when nothing matches', () => {
    expect(() => resolveExecutable('vat-no-such-binary-9f3a')).toThrow(/vat-no-such-binary-9f3a.*PATH/);
  });

  it('caches git for the process and agrees with a fresh resolution', () => {
    expect(gitExecutable()).toBe(gitExecutable());
    expect(gitExecutable()).toBe(resolveExecutable('git'));
  });

  it('NODE_EXECUTABLE is the running node, absolute', () => {
    expect(NODE_EXECUTABLE).toBe(process.execPath);
    expect(isAbsolutePath(NODE_EXECUTABLE)).toBe(true);
  });
});

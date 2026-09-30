/**
 * The refusals for an input the CONFIG or an earlier step names: an absence is
 * the caller's code and sentence; anything else the OS refused is
 * `INPUT_UNREADABLE` — never read as absent, never `INTERNAL_ERROR`.
 */

import { readFileSync, statSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { configNamedFileAbsent, readInputFile, requireInputPath } from '../../src/utils/project-root-policy.js';
import { errno, thrownBy } from '../helpers/refusal-doubles.js';

vi.mock('node:fs', async (importOriginal) =>
  (await import('../helpers/refusal-doubles.js')).spiedModule(importOriginal, ['readFileSync', 'statSync']));

const TARGET = '/project/dist/thing';
const ABSENT = { code: 'CONFIG_INVALID', message: 'publish.readme names README.md, which does not exist.' } as const;

afterEach(() => {
  vi.clearAllMocks();
});

describe('requireInputPath', () => {
  it('refuses an absent path with the caller\'s code and message', () => {
    vi.mocked(statSync).mockImplementationOnce(() => { throw errno('ENOENT'); });
    const error = thrownBy(() => requireInputPath(TARGET, ABSENT));
    expect(refusalCodeOf(error)).toBe('CONFIG_INVALID');
    expect((error as Error).message).toBe(ABSENT.message);
  });

  it('refuses a path the OS will not stat as INPUT_UNREADABLE, not as absent', () => {
    vi.mocked(statSync).mockImplementationOnce(() => { throw errno('EACCES'); });
    const error = thrownBy(() => requireInputPath(TARGET, ABSENT));
    expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
    expect((error as Error).message).toContain('EACCES');
  });
});

describe('readInputFile', () => {
  it('returns the file\'s text when it reads', () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => 'hello');
    expect(readInputFile(TARGET, ABSENT)).toBe('hello');
  });

  it('refuses an absent file with the caller\'s code and message', () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw errno('ENOENT'); });
    const error = thrownBy(() => readInputFile(TARGET, ABSENT));
    expect(refusalCodeOf(error)).toBe('CONFIG_INVALID');
    expect((error as Error).message).toBe(ABSENT.message);
  });

  it('refuses a file the OS will not read as INPUT_UNREADABLE', () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw errno('EISDIR'); });
    expect(refusalCodeOf(thrownBy(() => readInputFile(TARGET, ABSENT)))).toBe('INPUT_UNREADABLE');
  });
});

describe('configNamedFileAbsent', () => {
  it('is the config\'s mistake, naming the key and the file', () => {
    expect(configNamedFileAbsent('publish.changelog', 'CHANGES.md')).toStrictEqual({
      code: 'CONFIG_INVALID',
      message: 'publish.changelog names CHANGES.md, which does not exist.',
    });
  });
});

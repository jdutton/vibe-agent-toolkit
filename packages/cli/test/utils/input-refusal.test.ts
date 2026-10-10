/**
 * The refusals for an input the CONFIG, an earlier step or the command line names:
 * an absence keeps the caller's sentence under the refusal the table owes the
 * input's ORIGIN (carrying the classified fault as its cause); anything else the OS
 * refused is the classified `source` fault itself — never read as absent, never
 * `INTERNAL_ERROR`.
 */

import { readFileSync, statSync } from 'node:fs';

import { FS_FAULT_CODE } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { configNamedFileAbsent, readInputFile, requireInputPath } from '../../src/utils/project-root-policy.js';
import { errno, thrownBy } from '../helpers/refusal-doubles.js';

vi.mock('node:fs', async (importOriginal) =>
  (await import('../helpers/refusal-doubles.js')).spiedModule(importOriginal, ['readFileSync', 'statSync']));

const TARGET = '/project/dist/thing';
const ABSENT = { origin: 'config', message: 'publish.readme names README.md, which does not exist.' } as const;

afterEach(() => {
  vi.clearAllMocks();
});

describe('requireInputPath', () => {
  it.each([
    ['config', 'CONFIG_INVALID'],
    ['argument', 'USAGE_INVALID'],
    ['content', 'INPUT_UNREADABLE'],
  ] as const)('refuses an absent path named by %s as the table\'s %s, in the caller\'s words', (origin, refusal) => {
    vi.mocked(statSync).mockImplementationOnce(() => { throw errno('ENOENT'); });
    const error = thrownBy(() => requireInputPath(TARGET, { origin, message: ABSENT.message }));
    expect(refusalCodeOf(error)).toBe(refusal);
    expect((error as Error).message).toBe(ABSENT.message);
    // The classified fault rides along, so a judge walking the cause chain sees the same table row.
    expect((error as { cause?: unknown }).cause).toMatchObject({ code: FS_FAULT_CODE, side: 'source', origin, faultClass: 'absent', path: TARGET });
  });

  it('classifies a path the OS will not stat as a source fault, INPUT_UNREADABLE, not as absent', () => {
    vi.mocked(statSync).mockImplementationOnce(() => { throw errno('EACCES'); });
    const error = thrownBy(() => requireInputPath(TARGET, ABSENT));
    expect(error).toMatchObject({ code: FS_FAULT_CODE, side: 'source', faultClass: 'refused', path: TARGET });
    expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
    expect((error as Error).message).toContain('EACCES');
  });

  it('classifies the machine running out while it stats as the run not finishing', () => {
    vi.mocked(statSync).mockImplementationOnce(() => { throw errno('EMFILE'); });
    expect(refusalCodeOf(thrownBy(() => requireInputPath(TARGET, ABSENT)))).toBe('RUN_INCOMPLETE');
  });
});

describe('readInputFile', () => {
  it('returns the file\'s text when it reads', () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => 'hello');
    expect(readInputFile(TARGET, ABSENT)).toBe('hello');
  });

  it('refuses an absent file under the refusal its origin owes, with the caller\'s message', () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw errno('ENOENT'); });
    const error = thrownBy(() => readInputFile(TARGET, ABSENT));
    expect(refusalCodeOf(error)).toBe('CONFIG_INVALID');
    expect((error as Error).message).toBe(ABSENT.message);
  });

  it('classifies a file the OS will not read as the input\'s: INPUT_UNREADABLE', () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw errno('EISDIR'); });
    const error = thrownBy(() => readInputFile(TARGET, ABSENT));
    expect(error).toMatchObject({ code: FS_FAULT_CODE, side: 'source', faultClass: 'wrong-type' });
    expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
  });
});

describe('configNamedFileAbsent', () => {
  it('is the config\'s mistake, naming the key and the file', () => {
    expect(configNamedFileAbsent('publish.changelog', 'CHANGES.md')).toStrictEqual({
      origin: 'config',
      message: 'publish.changelog names CHANGES.md, which does not exist.',
    });
  });
});

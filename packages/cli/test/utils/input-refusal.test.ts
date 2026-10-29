/**
 * The refusals for an input the CONFIG, an earlier step or the command line names:
 * an absence keeps the caller's sentence under the refusal the table owes the
 * input's ORIGIN (carrying the classified fault as its cause); anything else the OS
 * refused is the classified `source` fault itself — never read as absent, never
 * `INTERNAL_ERROR`.
 */

import nodeFs, { readFileSync } from 'node:fs';

import { everywhere, FS_FAULT_CODE, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { configNamedFileAbsent, readInputFile, requireInputPath } from '../../src/utils/project-root-policy.js';
import { errno, refusingOnly, thrownBy } from '../helpers/refusal-doubles.js';

vi.mock('node:fs', async (importOriginal) =>
  (await import('../helpers/refusal-doubles.js')).spiedModule(importOriginal, ['readFileSync']));

// A path that exists: the link walk answers an absent one itself, before the injected `stat` is reached.
const TARGET = safePath.resolve(import.meta.dirname);
const ABSENT = { origin: 'config', message: 'publish.readme names README.md, which does not exist.' } as const;

// `requireInputPath` stats through utils' link-following, which reaches the kernel through the
// DEFAULT `node:fs` object, shared by every module: the refusal is a spy on that object.
const realStat = nodeFs.statSync;
function refuseStat(code: string): void {
  vi.spyOn(nodeFs, 'statSync').mockImplementation(refusingOnly(TARGET, errno(code), realStat));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('requireInputPath', () => {
  it.each([
    ['config', 'CONFIG_INVALID'],
    ['argument', 'USAGE_INVALID'],
    ['content', 'INPUT_UNREADABLE'],
  ] as const)('refuses an absent path named by %s as the table\'s %s, in the caller\'s words', (origin, refusal) => {
    refuseStat('ENOENT');
    const error = thrownBy(() => requireInputPath(TARGET, TARGET, { origin, message: ABSENT.message }, everywhere('source')));
    expect(refusalCodeOf(error)).toBe(refusal);
    expect((error as Error).message).toBe(ABSENT.message);
    // The classified fault rides along, so a judge walking the cause chain sees the same table row.
    expect((error as { cause?: unknown }).cause).toMatchObject({ code: FS_FAULT_CODE, side: 'source', origin, faultClass: 'absent', path: TARGET });
  });

  it('classifies a path the OS will not stat as a source fault, INPUT_UNREADABLE, not as absent', () => {
    refuseStat('EACCES');
    const error = thrownBy(() => requireInputPath(TARGET, TARGET, ABSENT, everywhere('source')));
    expect(error).toMatchObject({ code: FS_FAULT_CODE, side: 'source', faultClass: 'refused', path: TARGET });
    expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
    expect((error as Error).message).toContain('EACCES');
  });

  it('classifies the machine running out while it stats as the run not finishing', () => {
    refuseStat('EMFILE');
    expect(refusalCodeOf(thrownBy(() => requireInputPath(TARGET, TARGET, ABSENT, everywhere('source'))))).toBe('RUN_INCOMPLETE');
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

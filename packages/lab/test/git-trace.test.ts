import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { countGitTrace } from '../src/harness/git-trace.js';

const FIXTURES = safePath.join(import.meta.dirname, 'fixtures');

describe('countGitTrace', () => {
  it('counts every start event across the files and keys each by its verb, past global options', () => {
    expect(countGitTrace(safePath.join(FIXTURES, 'git-trace'))).toEqual({
      spawns: 5,
      byVerb: { status: 1, add: 1, 'ls-files': 1, 'rev-parse': 1, diff: 1 },
    });
  });

  it('names the file and line of a malformed line', () => {
    const dir = safePath.join(FIXTURES, 'git-trace-malformed');

    expect(() => countGitTrace(dir)).toThrow(`${safePath.join(dir, 'bad.json')} line 2`);
  });
});

/**
 * `vat rag index` reads its run's content reader after the run closes, which is sound only when
 * every file keyed from disk: a git member is read through object readers the run closes. The
 * assertion that guards the read must pass a disk lane and refuse a lane whose members key by
 * object ID.
 */

import { NO_GIT_MEMBERS, RunContentCache } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import type { GitMembers } from '@vibe-agent-toolkit/utils/git';
import { describe, expect, it } from 'vitest';

import { contentReadableAfterRun } from '../../../src/commands/rag/index-command.js';

const ROOT = safePath.join(normalizedTmpdir(), 'vat-rag-content-after-run');

/** Members holding no file: what only matters here is that they resolved to some. */
const SOME_MEMBERS: GitMembers = {
  repositoryRoot: ROOT,
  memberAt: () => undefined,
  sizeOf: () => Promise.reject(new Error('no member is sized')),
  bytesOf: () => Promise.reject(new Error('no member is read')),
};

describe('contentReadableAfterRun', () => {
  it('hands back the reader of a run that keyed every file from disk', () => {
    const disk = new RunContentCache(NO_GIT_MEMBERS);
    expect(contentReadableAfterRun(disk, ROOT)).toBe(disk);
    // A git lane whose members resolved to none (a partial clone on an old git) read disk too.
    const none = new RunContentCache({ root: ROOT, resolve: () => null });
    expect(contentReadableAfterRun(none, ROOT)).toBe(none);
  });

  it('refuses the reader of a run that keyed git members under its root', () => {
    const git = new RunContentCache({ root: ROOT, resolve: () => SOME_MEMBERS });
    expect(() => contentReadableAfterRun(git, ROOT)).toThrow(/keyed git members/u);
  });
});

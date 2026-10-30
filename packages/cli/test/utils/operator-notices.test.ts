/**
 * The one notice route and the one "am I the supervised checks child" predicate.
 *
 * Which process prints which notice under each invocation is pinned end to end in
 * `checks-notices.system.test.ts`; here, the seam itself: the audience is a SCOPE, decided by the
 * caller, so nothing outside it — a later command in one process, the next test — inherits it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EVERY_NOTICE,
  isSupervisedChild,
  noticeToOperator,
  withNoticeAudience,
} from '../../src/utils/operator-notices.js';

/** A spy on stderr that swallows the writes. */
function captureStderr(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process.stderr, 'write').mockReturnValue(true);
}

describe('isSupervisedChild — read from the explicit argv', () => {
  it('is true exactly when --cost-log was passed', () => {
    expect(isSupervisedChild({ costLog: '/minted/progress.jsonl' })).toBe(true);
    expect(isSupervisedChild({ costLog: undefined })).toBe(false);
  });
});

describe('noticeToOperator — the audience is a scope', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints every kind outside any scope', () => {
    const stderr = captureStderr();

    noticeToOperator('config', 'unknown key `bogus`');
    noticeToOperator('store', 'not inside a readable git repository');

    expect(stderr.mock.calls).toStrictEqual([['unknown key `bogus`\n'], ['not inside a readable git repository\n']]);
  });

  it('prints only the kinds its scope owes', () => {
    const stderr = captureStderr();

    withNoticeAudience({ config: false, store: true }, () => {
      noticeToOperator('config', 'unknown key `bogus`');
      noticeToOperator('store', 'not inside a readable git repository');
    });

    expect(stderr.mock.calls).toStrictEqual([['not inside a readable git repository\n']]);
  });

  it('reaches work the scope awaits', async () => {
    const stderr = captureStderr();

    await withNoticeAudience({ config: false, store: false }, async () => {
      await Promise.resolve();
      noticeToOperator('config', 'unknown key `bogus`');
    });

    expect(stderr).not.toHaveBeenCalled();
  });

  it('ends with its scope: the next notice is printed', () => {
    withNoticeAudience({ config: false, store: false }, () => undefined);
    const stderr = captureStderr();

    noticeToOperator('config', 'unknown key `bogus`');

    expect(stderr).toHaveBeenCalledExactlyOnceWith('unknown key `bogus`\n');
    expect(EVERY_NOTICE).toStrictEqual({ config: true, store: true });
  });
});

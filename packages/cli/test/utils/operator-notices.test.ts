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
  resetUnscopedNoticeLedger,
  withNoticeAudience,
  withNoticeLedger,
} from '../../src/utils/operator-notices.js';

/** A spy on stderr that swallows the writes. */
function captureStderr(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process.stderr, 'write').mockReturnValue(true);
}

describe('isSupervisedChild — read from the explicit argv', () => {
  it('is true exactly when --supervised-by was passed', () => {
    expect(isSupervisedChild({ supervisedBy: 'phase:1:/minted/progress.jsonl' })).toBe(true);
    expect(isSupervisedChild({ supervisedBy: undefined })).toBe(false);
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

describe('noticeToOperator — "once" belongs to the scope', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetUnscopedNoticeLedger();
  });

  it('prints a keyed notice once per scope, and again in the next scope', () => {
    const stderr = captureStderr();
    const twice = (): void => {
      noticeToOperator('store', 'cannot key /r', '/r');
      noticeToOperator('store', 'cannot key /r', '/r');
    };

    withNoticeLedger(() => {
      twice();
      // A nested ledger joins the enclosing scope rather than starting a fresh one.
      withNoticeLedger(twice);
    });
    withNoticeAudience(EVERY_NOTICE, twice);

    expect(stderr).toHaveBeenCalledTimes(2);
  });

  /**
   * 🚨 `vat validate` loads its config BEFORE it opens its population scope, and again inside it:
   * a fresh ledger there printed the unknown-key warning a second time for one run.
   */
  it('a fresh ledger remembers what was printed before it, and keeps its own prints to itself', () => {
    const stderr = captureStderr();

    noticeToOperator('config', 'config at /r', '/r');
    withNoticeLedger(() => {
      noticeToOperator('config', 'config at /r', '/r');
      noticeToOperator('store', 'store at /r', '/r');
    });
    withNoticeLedger(() => noticeToOperator('store', 'store at /r', '/r'));

    expect(stderr.mock.calls).toStrictEqual([['config at /r\n'], ['store at /r\n'], ['store at /r\n']]);
  });

  it('keys by kind as well as key, and outside every scope until the ledger is reset', () => {
    const stderr = captureStderr();

    noticeToOperator('config', 'config at /r', '/r');
    noticeToOperator('store', 'store at /r', '/r');
    noticeToOperator('config', 'config at /r', '/r');
    resetUnscopedNoticeLedger();
    noticeToOperator('config', 'config at /r', '/r');

    expect(stderr.mock.calls).toStrictEqual([['config at /r\n'], ['store at /r\n'], ['config at /r\n']]);
  });
});

/**
 * The refusal seam has NO default. A listing that meets a directory it cannot
 * open must either stop with the adopter's sentence or hand the gap to a caller
 * that promised to report it — and which of the two is a decision the caller
 * makes, at the call site, every time.
 *
 * 🪤 This used to be `onUnreadable?`, an optional callback. Two things followed.
 * At the type level every caller that ignored it compiled, so a miss surfaced
 * one review round later as a HIGH (`vat audit` silently in wild mode, round 6).
 * At runtime the two lanes defaulted DIFFERENTLY: the walk threw a
 * programmer-facing sentence, while `git ls-files` — whose only witness to a
 * refused directory is its stderr — dropped the refusal on the floor when no
 * handler was given (`if (onUnreadable !== undefined …)`), which is the shorter
 * list nothing can tell from a complete one.
 *
 * `tsc` now enumerates the callers (`unreadable` is required on the options
 * type). This file pins the RUNTIME half, because test files and JavaScript
 * adopters are not typechecked: an omitted policy is refused up front, by
 * name, before any directory is listed — not on the first refusal, and never
 * silently. What each arm DOES is pinned beside the walk and the git route in
 * `file-crawler-refused-listing.test.ts` / `file-crawler-git-refused-listing.test.ts`.
 */
import { writeFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { crawlDirectorySync } from '../src/file-crawler.js';
import { gitLsFiles, gitLsOthers } from '../src/git-utils.js';
import { mkdirSyncReal, safePath } from '../src/path-utils.js';
import { setupSyncTempDirSuite } from '../src/testing/temp-dir.js';

import { createGitRepo } from './test-helpers.js';

/** Every entry point that lists directories, called WITHOUT a policy. */
const WITHOUT_POLICY = [
  ['crawlDirectorySync', (root: string) => crawlDirectorySync({ baseDir: root, respectGitignore: false } as never)],
  ['gitLsFiles', (root: string) => gitLsFiles({ cwd: root, includeUntracked: true } as never)],
  ['gitLsOthers', (root: string) => gitLsOthers({ cwd: root, ignored: true, directory: true } as never)],
] as const;

describe('the unreadable policy is required at runtime, not only at the type level', () => {
  const suite = setupSyncTempDirSuite('unreadable-policy-required');
  let root: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    root = suite.getTempDir();
    mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
    writeFileSync(safePath.join(root, 'docs', 'ok.md'), '# ok\n');
    createGitRepo(root);
  });

  it.each(WITHOUT_POLICY)('%s refuses an omitted policy by name, even when nothing refuses', (_name, call) => {
    // Nothing in this tree is unreadable. The old optional seam let this call
    // return a complete list; a policy that only mattered on the first refusal
    // would let it too — and would then differ per lane.
    expect(() => call(root)).toThrow(TypeError);
    expect(() => call(root)).toThrow(/`unreadable`/);
    expect(() => call(root)).toThrow(/refuse/);
    expect(() => call(root)).toThrow(/degrade/);
  });
});

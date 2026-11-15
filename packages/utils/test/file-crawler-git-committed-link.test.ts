/**
 * The GIT route of `crawlDirectorySync` must not hand a committed symbolic link to its caller's
 * `readFile` unread: `git ls-files` lists a mode-120000 entry like any file, and a reader that opens
 * it makes the kernel resolve the link — on Windows a link to `\\host\share` sends the operator's
 * credentials there. So a committed link is read by its chain beneath the crawl's base first, exactly
 * as the walk's `processSymlink` reads one: a chain VAT will not follow is the link's own fault under
 * the caller's policy — a gap under `degrade`, the classified fault under `refuse` — and the member is
 * dropped. The host flavor is bound to `win32` so Windows semantics run on every host (on POSIX the
 * text is one legal file name).
 */
import nodeFs, { writeFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { crawlDirectorySync, type DirectoryRefusal, type UnreadablePolicy } from '../src/file-crawler.js';
import { runGitOrThrow } from '../src/git-run.js';
import { safePath, toForwardSlash } from '../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../src/test-helpers.js';
import { setupSyncTempDirSuite } from '../src/testing/temp-dir.js';

import { createGitRepo } from './test-helpers.js';

vi.mock('../src/tree-change/link-chain.js', async (importOriginal) => ({ ...(await importOriginal<object>()), HOST_PATH_FLAVOR: 'win32' }));

const UNC = String.raw`\\attacker\share\r.md`;

type Route = { respectGitignore: boolean; followSymlinks?: boolean };
const GIT_ROUTE: Route = { respectGitignore: true };
const WALK_ROUTE: Route = { respectGitignore: false, followSymlinks: true };

/** `ok.md`, `README.md -> \\attacker\share\r.md` and `alias.md -> ok.md` under `root` (committed for the git route). */
function plantLinks(root: string, route: Route, skip: () => never): void {
  const cap = symlinkCapability() ?? skip();
  if (route.respectGitignore) {
    createGitRepo(root);
    runGitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    runGitOrThrow(['config', 'user.name', 'Test'], { cwd: root });
  }
  writeFileSync(safePath.join(root, 'ok.md'), '# ok\n');
  createSymlink(cap, UNC, safePath.join(root, 'README.md'), 'file');
  createSymlink(cap, 'ok.md', safePath.join(root, 'alias.md'), 'file');
  if (route.respectGitignore) {
    runGitOrThrow(['add', '-A'], { cwd: root });
    runGitOrThrow(['commit', '-qm', 'init'], { cwd: root });
  }
}

function crawl(root: string, route: Route, unreadable: UnreadablePolicy): string[] {
  return crawlDirectorySync({ outputs: [], baseDir: root, include: ['**/*.md'], absolute: false, ...route, unreadable });
}

/** Crawl the root's `*.md` by `route` under `degrade`, asserting the one population both routes owe. */
function expectNetworkLinkDropped(root: string, route: Route): void {
  const gaps: DirectoryRefusal[] = [];
  const found = crawl(root, route, { degrade: (refusal) => gaps.push(refusal) });

  expect(found.toSorted((a, b) => a.localeCompare(b))).toEqual(['alias.md', 'ok.md']);
  expect(gaps.map((gap) => ({ at: toForwardSlash(gap.directory), code: gap.code }))).toEqual([
    { at: safePath.join(root, 'README.md'), code: 'LINK_CHAIN_REFUSED' },
  ]);
}

describe('crawlDirectorySync: a committed symbolic link to a network path', () => {
  const suite = setupSyncTempDirSuite('crawl-git-committed-link');
  let root: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    root = toForwardSlash(suite.getTempDir());
  });

  it('git route: drops it as a refused gap, and keeps a local one', ({ skip }) => {
    plantLinks(root, GIT_ROUTE, skip);
    expectNetworkLinkDropped(root, GIT_ROUTE);
  });

  // The walk route, following links: the same rule, read in `processSymlink` before any `stat`.
  it('walk route following links: refuses the same link as a gap, and never stats it', ({ skip }) => {
    plantLinks(root, WALK_ROUTE, skip);
    const stat = vi.spyOn(nodeFs, 'statSync');
    try {
      expectNetworkLinkDropped(root, WALK_ROUTE);
      expect(stat.mock.calls.map(([path]) => toForwardSlash(String(path)))).not.toContain(safePath.join(root, 'README.md'));
    } finally {
      stat.mockRestore();
    }
  });

  // Under `refuse` a link is not a directory: the throw is the classified fault on the link's side, never
  // a "listing refused" for a path nothing listed.
  it.for([['git', GIT_ROUTE], ['walk', WALK_ROUTE]] as const)('%s route under refuse: the link\'s own classified fault', ([, route], { skip }) => {
    plantLinks(root, route, skip);
    let thrown: unknown;
    try {
      crawl(root, route, { refuse: { root, remedy: 'fix it', side: 'destination' } });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'FS_FAULT', errno: 'LINK_CHAIN_REFUSED', side: 'destination', faultClass: 'refused' });
    expect(thrown).not.toHaveProperty('refusal');
  });
});

/**
 * A crawl source's `symlinks` describes its LAST enumeration, not every one it
 * ever ran. A source enumerated twice — a link deleted between the two — must
 * not keep reporting the link, or its condition row outlives the file.
 */

import { rmSync } from 'node:fs';

import { createSymlink, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FilesystemCrawlSource, GitCrawlSource } from '../src/projection/crawl-source.js';

import { plantSymlinkFixture, removeSymlinkFixture } from './helpers/symlink-fixture.js';

const TARGET = 'target.md';
const KEPT_LINK = 'kept.md';
const REMOVED_LINK = 'removed.md';
const CAPABILITY = symlinkCapability();

describe.skipIf(CAPABILITY === null)('a re-enumerated crawl source forgets a deleted link', () => {
  let root: string | undefined;

  beforeAll(() => {
    root = plantSymlinkFixture({
      prefix: 'vat-reenumerate-',
      files: [TARGET],
      links: [{ path: KEPT_LINK, target: TARGET }],
      untrackedLinks: [{ path: REMOVED_LINK, target: TARGET }],
    }).root;
  });

  afterAll(() => {
    removeSymlinkFixture(root);
  });

  it.each([
    ['filesystem', (at: string) => new FilesystemCrawlSource(at)],
    ['git', (at: string) => new GitCrawlSource(at)],
  ] as const)('%s source', async (_label, make) => {
    if (root === undefined) throw new Error('fixture not planted');
    if (CAPABILITY === null) throw new Error('unreachable — the suite is skipped without the capability');
    const capability = CAPABILITY;
    const source = make(root);
    const names = (): string[] => source.symlinks.map((link) => link.slice(link.lastIndexOf('/') + 1));

    await source.enumerate();
    // Positive control: both links were recorded the first time.
    expect(names()).toEqual([KEPT_LINK, REMOVED_LINK]);

    rmSync(safePath.join(root, REMOVED_LINK));
    try {
      await source.enumerate();
      expect(names()).toEqual([KEPT_LINK]);
    } finally {
      // One fixture serves both arms, so the next one starts from the same tree.
      createSymlink(capability, TARGET, safePath.join(root, REMOVED_LINK));
    }
  });
});

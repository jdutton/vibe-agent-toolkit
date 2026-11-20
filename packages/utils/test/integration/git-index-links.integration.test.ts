/**
 * `gitLinksCheckedOutAsFiles` against a real index: every spelling git reads as
 * a false `core.symlinks` turns the read on, and the index is read under the
 * listed root alone. A link is staged with `update-index --cacheinfo`, so the
 * suite needs no symlink support and runs on Windows too.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitLinksCheckedOutAsFiles } from '../../src/git-index-links.js';
import { runGit } from '../../src/git-run.js';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '../../src/path-utils.js';

/** Run git in `cwd`, failing the test on a refusal. */
function git(cwd: string, ...args: string[]): string {
  const result = runGit(args, { cwd });
  expect(result.ok, `git ${args.join(' ')}: ${result.stderr}`).toBe(true);
  return result.stdout;
}

describe('gitLinksCheckedOutAsFiles over a real index', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-index-links-'));
    git(dir, 'init', '-q');
    mkdirSyncReal(safePath.join(dir, 'docs'));
    writeFileSync(safePath.join(dir, 'target.md'), '# Target\n');
    const oid = git(dir, 'hash-object', '-w', 'target.md');
    // A link inside the listed root and one outside it, both written as plain files.
    git(dir, 'update-index', '--add', '--cacheinfo', `120000,${oid},docs/link.md`);
    git(dir, 'update-index', '--add', '--cacheinfo', `120000,${oid},outside.md`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['false', 'no', 'off', '0'])('reads core.symlinks=%s as false', (value) => {
    git(dir, 'config', 'core.symlinks', value);
    expect([...gitLinksCheckedOutAsFiles(safePath.join(dir, 'docs'))]).toEqual([safePath.join(dir, 'docs', 'link.md')]);
  });

  it.each(['true', 'yes', '1'])('reads nothing for core.symlinks=%s', (value) => {
    git(dir, 'config', 'core.symlinks', value);
    expect(gitLinksCheckedOutAsFiles(safePath.join(dir, 'docs')).size).toBe(0);
  });
});

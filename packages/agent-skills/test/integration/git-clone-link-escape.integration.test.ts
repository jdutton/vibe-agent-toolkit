/**
 * A cloned repository is untrusted input, and its symbolic links are part of
 * it. `cloneGitSource` used to judge the `#ref:subpath` lexically, so a
 * committed `skills -> /somewhere/outside` passed and every reader that
 * followed `targetDir` read the operator's own files as the repository's.
 *
 * Integration tier: each case commits real links into a real repository and
 * clones it with real git. POSIX only — git on Windows checks a link out as a
 * plain file unless `core.symlinks` is on, so there is no link to escape with.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  COPY_LINK_ESCAPES_SOURCE_CODE,
  createSymlink,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  symlinkCapability,
} from '@vibe-agent-toolkit/utils';
import { parseGitUrl } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cloneGitSource, GIT_SUBPATH_INVALID_CODE } from '../../src/skill-source/git-clone.js';
import { makeBareRepoWithSkill } from '../skill-source/test-helpers.js';

/** A directory outside every clone, holding a file no clone owns. */
let outside: string;
const cleanups: Array<() => void> = [];

beforeAll(() => {
  outside = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-gc-outside-'));
  writeFileSync(safePath.join(outside, 'SKILL.md'), '# not the repository\'s\n');
  cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
});

afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

/** Clone a repo whose work-tree `shape` built, at `#main:<subpath>`. */
function cloneShaped(shape: (workDir: string) => void, subpath?: string): () => ReturnType<typeof cloneGitSource> {
  const repo = makeBareRepoWithSkill({ skillSubdir: 'plugins/foo', beforeCommit: shape });
  cleanups.push(repo.cleanup);
  const tempdir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-gc-link-'));
  cleanups.push(() => rmSync(tempdir, { recursive: true, force: true }));
  const url = subpath === undefined ? `${repo.bareUrl}#main` : `${repo.bareUrl}#main:${subpath}`;
  return () => cloneGitSource(parseGitUrl(url), tempdir);
}

describe.skipIf(process.platform === 'win32')('cloneGitSource refuses links out of the clone', () => {
  it('refuses a subpath that is itself a committed link to a directory outside the clone', ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const clone = cloneShaped((work) => createSymlink(cap, outside, safePath.join(work, 'skills')), 'skills');
    expect(clone).toThrow(expect.objectContaining({
      code: GIT_SUBPATH_INVALID_CODE,
      message: expect.stringMatching(/escapes the cloned repository: skills/),
    }));
  });

  it('refuses a link inside the selected subtree whose target is outside the clone', ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const clone = cloneShaped((work) => createSymlink(cap, outside, safePath.join(work, 'plugins/foo/evil')), 'plugins/foo');
    expect(clone).toThrow(expect.objectContaining({
      code: COPY_LINK_ESCAPES_SOURCE_CODE,
      message: expect.stringContaining('plugins/foo/evil is a symbolic link to a path outside the clone'),
    }));
  });

  it('refuses a second-hop escape: an inside link into a sibling that holds a link out', ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const clone = cloneShaped((work) => {
      mkdirSyncReal(safePath.join(work, 'shared'));
      createSymlink(cap, outside, safePath.join(work, 'shared', 'out'));
      createSymlink(cap, '../../shared', safePath.join(work, 'plugins/foo/shared'));
    }, 'plugins/foo');
    expect(clone).toThrow(expect.objectContaining({ code: COPY_LINK_ESCAPES_SOURCE_CODE }));
  });

  it('refuses a dangling link aimed outside the clone', ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const clone = cloneShaped(
      (work) => createSymlink(cap, safePath.join(outside, 'not-there'), safePath.join(work, 'plugins/foo/later')),
      'plugins/foo',
    );
    expect(clone).toThrow(expect.objectContaining({ code: COPY_LINK_ESCAPES_SOURCE_CODE }));
  });

  it('accepts links that stay inside the clone, including a cycle', ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const clone = cloneShaped((work) => {
      mkdirSyncReal(safePath.join(work, 'docs'));
      writeFileSync(safePath.join(work, 'docs', 'guide.md'), '# guide\n');
      createSymlink(cap, '../../docs', safePath.join(work, 'plugins/foo/docs'));
      createSymlink(cap, '.', safePath.join(work, 'plugins/foo/self'));
    }, 'plugins/foo');
    expect(clone().targetDir).toMatch(/plugins\/foo$/);
  });
});

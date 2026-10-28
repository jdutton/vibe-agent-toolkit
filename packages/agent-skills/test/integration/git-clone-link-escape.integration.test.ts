/**
 * A cloned repository is untrusted input, and its symbolic links are part of
 * it. `cloneGitSource` used to judge the `#ref:subpath` lexically, so a
 * committed `skills -> /somewhere/outside` passed and every reader that
 * followed `targetDir` read the operator's own files as the repository's.
 *
 * Integration tier: each case commits links into a real repository and clones
 * it with real git. The cases that judge a link by its TEXT commit it straight
 * into the index (`links`), so they run on every host, Windows CI included —
 * where the clone must be refused from the object store, before a checkout
 * writes the link and Git for Windows resolves it. The cases that need the
 * kernel to follow a checked-out link are POSIX only: git on Windows checks a
 * link out as a plain file unless `core.symlinks` is on.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import {
  COPY_LINK_ESCAPES_SOURCE_CODE,
  createSymlink,
  FS_FAULT_CODE,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  symlinkCapability,
} from '@vibe-agent-toolkit/utils';
import { parseGitUrl } from '@vibe-agent-toolkit/utils/git';
import { installFaultFs } from '@vibe-agent-toolkit/utils/testing';
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
  return cloneShapedInto(shape, subpath).clone;
}

/** {@link cloneShaped}, and the directory the clone lands in; `links` committed into the index as text. */
function cloneShapedInto(shape: (workDir: string) => void, subpath?: string, links: Readonly<Record<string, string>> = {}): { clone: () => ReturnType<typeof cloneGitSource>; tempdir: string } {
  const repo = makeBareRepoWithSkill({ skillSubdir: 'plugins/foo', beforeCommit: shape, links });
  cleanups.push(repo.cleanup);
  const tempdir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-gc-link-'));
  cleanups.push(() => rmSync(tempdir, { recursive: true, force: true }));
  const url = subpath === undefined ? `${repo.bareUrl}#main` : `${repo.bareUrl}#main:${subpath}`;
  return { clone: () => cloneGitSource(parseGitUrl(url), tempdir), tempdir };
}

/** Every filesystem call the clone made that names the link's target: the kernel asked to resolve it. */
function callsNaming(tempdir: string, clone: () => unknown, needle: string): { thrown: unknown; asked: string[] } {
  const session = installFaultFs({ within: tempdir });
  let thrown: unknown;
  try {
    clone();
  } catch (error) {
    thrown = error;
  } finally {
    session.restore();
  }
  return { thrown, asked: session.calls.filter((call) => call.path.includes(needle)).map((call) => `${call.op} ${call.path}`) };
}

/** A UNC text. On POSIX it is one relative filename, so the kernel asked about it shows as a call naming it. */
const UNC = String.raw`\\attacker\share\x`;
const noShape = (): void => undefined;

/** The clone, with `op` on the path ending `suffix` refused `EACCES`, fails as the source's own fault. */
function expectSourceSideRefusal(clone: () => unknown, tempdir: string, op: 'lstat' | 'readlink', suffix: string): void {
  const session = installFaultFs({ within: tempdir, faults: [{ op, path: (path) => path.endsWith(suffix), errno: 'EACCES' }] });
  try {
    expect(clone).toThrow(expect.objectContaining({ code: FS_FAULT_CODE, errno: 'EACCES', side: 'source', origin: 'content' }));
  } finally {
    session.restore();
  }
}

// R11-WIN-I1/I2: on every host — the Windows leg is the one these exist for. The clone is refused
// from the object store: no call names the share, and nothing but `.git` was ever written.
describe('cloneGitSource refuses a committed link by its text before checkout, on every host', () => {
  it('refuses a committed UNC link before any filesystem call resolves its target', () => {
    const { clone, tempdir } = cloneShapedInto(noShape, 'plugins/foo', { 'plugins/foo/smb': UNC });
    const { thrown, asked } = callsNaming(tempdir, clone, 'attacker');
    expect(thrown).toEqual(expect.objectContaining({ code: COPY_LINK_ESCAPES_SOURCE_CODE, message: expect.stringContaining('plugins/foo/smb is a symbolic link whose target leads through a network path') }));
    expect(asked).toEqual([]);
    expect(readdirSync(tempdir)).toEqual(['.git']);
  });

  it('refuses a subpath that leads through a committed UNC link, as the subpath, before checkout', () => {
    const { clone, tempdir } = cloneShapedInto(noShape, 'skills/deeper', { skills: UNC });
    const { thrown, asked } = callsNaming(tempdir, clone, 'attacker');
    expect(thrown).toEqual(expect.objectContaining({ code: GIT_SUBPATH_INVALID_CODE, message: expect.stringMatching(/escapes the cloned repository: skills\/deeper/) }));
    expect(asked).toEqual([]);
    expect(readdirSync(tempdir)).toEqual(['.git']);
  });

  // Every link of the commit: the checkout writes them all, wherever the subpath points.
  it.for([
    ['a UNC link outside the subpath', 'docs/smb', UNC],
    ['a namespaced UNC link', 'plugins/foo/ns', String.raw`\\?\UNC\attacker\share`],
    ['a drive-relative link', 'plugins/foo/drv', 'C:attacker'],
    ['a link whose text climbs out by string', 'plugins/foo/up', String.raw`..\..\..\attacker`],
  ] as const)('refuses %s before checkout', ([, path, text]) => {
    const { clone, tempdir } = cloneShapedInto(noShape, 'plugins/foo', { [path]: text });
    expect(clone).toThrow(expect.objectContaining({ code: COPY_LINK_ESCAPES_SOURCE_CODE, message: expect.stringContaining(`${path} is a symbolic link`) }));
    expect(readdirSync(tempdir)).toEqual(['.git']);
  });

  // R11-CONTRACT-M2/M3, R11-SEC-M1/M2: the clone's content is the input; a probe of it the OS
  // refuses is the input's fault (`INPUT_UNREADABLE`), as in the install lane — never raw, never VAT's own.
  it('classifies a refused probe of the subpath itself as a fault on the source side', () => {
    const { clone, tempdir } = cloneShapedInto(noShape, 'plugins/foo');
    expectSourceSideRefusal(clone, tempdir, 'lstat', '/plugins/foo');
  });

  it('checks out a commit whose links\' texts stay inside (positive control)', () => {
    const { clone } = cloneShapedInto(noShape, 'plugins/foo', { 'plugins/foo/alias.md': 'SKILL.md' });
    expect(clone().targetDir).toMatch(/plugins\/foo$/);
  });
});

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
      message: expect.stringContaining('plugins/foo/evil is a symbolic link whose target leads through an absolute path'),
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

  // The SUBPATH itself dangling: followLink's rule covered only links found while walking, so
  // this one reached readdir and left as a raw ENOENT instead of the subpath's refusal.
  it.for([
    ['aimed outside the clone', (): string => safePath.join(outside, 'not-there'), /escapes the cloned repository: skills\/esc/],
    ['aimed inside the clone', (): string => 'nowhere', /not found in cloned repo: skills\/esc/],
  ] as const)('refuses a subpath that is itself a dangling link %s, as the subpath', ([, target, message], { skip }) => {
    const cap = symlinkCapability() ?? skip();
    const clone = cloneShaped((work) => {
      mkdirSyncReal(safePath.join(work, 'skills'));
      createSymlink(cap, target(), safePath.join(work, 'skills', 'esc'));
    }, 'skills/esc');
    expect(clone).toThrow(expect.objectContaining({ code: GIT_SUBPATH_INVALID_CODE, message: expect.stringMatching(message) }));
  });

  it('classifies a refused readlink of a link under the subpath as a fault on the source side', ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const { clone, tempdir } = cloneShapedInto((work) => createSymlink(cap, 'SKILL.md', safePath.join(work, 'plugins/foo/l'), 'file'), 'plugins/foo');
    expectSourceSideRefusal(clone, tempdir, 'readlink', '/plugins/foo/l');
  });

  it('accepts links that stay inside the clone, including a link to its own directory', ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const clone = cloneShaped((work) => {
      mkdirSyncReal(safePath.join(work, 'docs'));
      writeFileSync(safePath.join(work, 'docs', 'guide.md'), '# guide\n');
      createSymlink(cap, '../../docs', safePath.join(work, 'plugins/foo/docs'));
      createSymlink(cap, '.', safePath.join(work, 'plugins/foo/self'));
    }, 'plugins/foo');
    expect(clone().targetDir).toMatch(/plugins\/foo$/);
  });

  // R11-CONTRACT-C1: a REAL cycle (`a -> b`, `b -> a`: the kernel answers ELOOP) resolves to
  // nothing, in every lane — under the subpath it reads nothing, as a dangle does; as the subpath it
  // names nothing. Never an `environment` fault, never a raw ELOOP.
  it('accepts a real link cycle under the subpath, as a link that leads to nothing', ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const clone = cloneShaped((work) => {
      createSymlink(cap, 'b', safePath.join(work, 'plugins/foo/a'), 'file');
      createSymlink(cap, 'a', safePath.join(work, 'plugins/foo/b'), 'file');
    }, 'plugins/foo');
    expect(clone().targetDir).toMatch(/plugins\/foo$/);
  });

  it('refuses a subpath that is a real link cycle as a subpath the clone does not hold', ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const clone = cloneShaped((work) => {
      createSymlink(cap, 'loop2', safePath.join(work, 'loop'), 'dir');
      createSymlink(cap, 'loop', safePath.join(work, 'loop2'), 'dir');
    }, 'loop');
    expect(clone).toThrow(expect.objectContaining({ code: GIT_SUBPATH_INVALID_CODE, message: expect.stringMatching(/not found in cloned repo: loop/) }));
  });
});

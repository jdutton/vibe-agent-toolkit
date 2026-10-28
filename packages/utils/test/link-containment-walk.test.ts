/**
 * `refuseEscapingLinks` over a tree held in memory: the filesystem calls it makes, and the path
 * resolution it relies on, answered from a map — so which link it refuses, what it says, which
 * directories it enters and how often, are seen without making a tree. The integration suite runs
 * the same checks against real links; this pins the walk's own decisions, on every host.
 *
 * The fake KERNEL models the flavor the test sets ({@link setKernel}), never the walk's own model:
 * a Windows kernel joins a link's text onto the link's directory with the rest of the path and
 * collapses every `..` by string before it reparses, and follows 63 reparse points; a POSIX kernel
 * follows a link before the `..` after it and gives up after 40. So a walk that reads `..` the
 * POSIX way under win32, or stops reading early, lets this kernel follow a link the walk never read.
 */
import type nodeFs from 'node:fs';
import { posix } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { isUnresolvableLinkError } from '../src/errors/errno-table.js';
import { FS_FAULT_CODE } from '../src/errors/fs-fault.js';
import { safePath, toForwardSlash, toForwardSlashAnyPlatform } from '../src/path-core.js';
import type { PathFlavor } from '../src/tree-change/link-chain.js';

/** One entry of the fake tree, by its real path. */
type Node = { readonly type: 'dir' } | { readonly type: 'file' } | { readonly type: 'link'; readonly target: string };

const tree = new Map<string, Node>();
const listed: string[] = [];
/** Paths whose `stat` the OS is made to refuse with this errno. */
const refusedStat = new Map<string, string>();
/** Every link text the kernel was asked to FOLLOW that names a host elsewhere — a spy on resolution, not a fault. */
const kernelFollowed: string[] = [];

const ROOT = safePath.resolve('/vat-fake-tree');

/** Whose kernel the fake answers as, and how many links it follows. */
let kernel: { readonly flavor: PathFlavor; readonly loopLimit: number } = { flavor: 'posix', loopLimit: 40 };
function setKernel(flavor: PathFlavor): void {
  kernel = { flavor, loopLimit: flavor === 'win32' ? 63 : 40 };
}

const errno = (code: string, syscall: string, path: string): Error => Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, syscall, path });

/** `path` split into its root and its components, `..` KEPT: the kernel, not a string resolve, decides what it means. */
function componentsOf(path: string): { base: string; parts: string[] } {
  const [first = '', ...rest] = toForwardSlash(path).split('/');
  return { base: first === '' ? '/' : `${first}/`, parts: rest.filter((part) => part !== '' && part !== '.') };
}

/** `at` (a real directory) and a link's text, joined as text: an absolute text replaces it. */
function spliced(at: string, text: string, rest: readonly string[]): string {
  const head = text.startsWith('/') ? text : `${at.replace(/\/$/, '')}/${text}`;
  return [head, ...rest].join('/');
}

/** The real path of `path`, every link followed (the last one too only when `followLast`); throws ENOENT / ENOTDIR / ELOOP as `kernel` does. */
function realOf(path: string, followLast: boolean, syscall: string, hops = { left: kernel.loopLimit }): string {
  // Windows collapses `..` by string over the whole name before it looks at anything.
  const { base, parts } = componentsOf(kernel.flavor === 'win32' ? posix.normalize(toForwardSlashAnyPlatform(path)) : path);
  // The root keeps its slash (`/`, `D:/`): `D:` alone is drive-relative on win32.
  let at = base;
  for (const [index, part] of parts.entries()) {
    if (part === '..') {
      // POSIX: the parent of the REAL place reached — after any link before it was followed.
      at = posix.dirname(at);
      continue;
    }
    const next = `${at.replace(/\/$/, '')}/${part}`;
    const node = tree.get(next);
    const last = index === parts.length - 1;
    if (node === undefined) throw errno('ENOENT', syscall, path);
    if (node.type !== 'link' || (last && !followLast)) {
      if (!last && node.type === 'file') throw errno('ENOTDIR', syscall, path);
      at = next;
      continue;
    }
    const reached = followed(at, node.target, parts.slice(index + 1), { path, followLast, syscall, hops });
    // Windows reparsed the whole remaining name; POSIX resolved the link alone and walks on from it.
    if (kernel.flavor === 'win32') return reached;
    at = reached;
  }
  return at;
}

/** Where the kernel takes the link at `at` with text `target` — under win32 together with the `rest` of the name. */
function followed(at: string, target: string, rest: readonly string[], ask: { path: string; followLast: boolean; syscall: string; hops: { left: number } }): string {
  if (target.includes('attacker')) kernelFollowed.push(target);
  ask.hops.left -= 1;
  if (ask.hops.left < 0) throw errno('ELOOP', ask.syscall, ask.path);
  // Reparse: the text joined onto the link's directory WITH the rest of the name, then re-parsed.
  if (kernel.flavor === 'win32') return realOf(spliced(at, toForwardSlashAnyPlatform(target), rest), ask.followLast, ask.syscall, ask.hops);
  return realOf(spliced(at, target, []), true, ask.syscall, ask.hops);
}

const statsOf = (node: Node | undefined): { isSymbolicLink(): boolean; isDirectory(): boolean } => ({
  isSymbolicLink: () => node?.type === 'link',
  isDirectory: () => node?.type === 'dir',
});

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof nodeFs>();
  return {
    ...real,
    lstatSync: (path: string) => statsOf(tree.get(realOf(path, false, 'lstat'))),
    statSync: (path: string) => {
      const refused = refusedStat.get(path);
      if (refused !== undefined) throw errno(refused, 'stat', path);
      return statsOf(tree.get(realOf(path, true, 'stat')));
    },
    readlinkSync: (path: string) => {
      const node = tree.get(realOf(path, false, 'readlink'));
      if (node?.type !== 'link') throw errno('EINVAL', 'readlink', path);
      return node.target;
    },
    readdirSync: (dir: string) => {
      const real = realOf(dir, true, 'scandir');
      listed.push(safePath.relative(ROOT, real) || '.');
      const prefix = `${real}/`;
      return [...tree.entries()]
        .filter(([path]) => toForwardSlash(path).startsWith(prefix) &&!path.slice(prefix.length).includes('/'))
        .map(([path, node]) => ({ name: path.slice(prefix.length), ...statsOf(node) }));
    },
  };
});

/** Real paths, as the containment module asks for them: the deepest existing ancestor resolved, the rest appended. */
vi.mock('../src/path-containment.js', () => {
  function canonical(target: string): { canonical: string; exists: boolean } {
    const { base, parts } = componentsOf(target);
    for (let keep = parts.length; keep >= 0; keep -= 1) {
      const head = `${base}${parts.slice(0, keep).join('/')}`;
      try {
        const real = realOf(head, true, 'realpath');
        return { canonical: safePath.join(real, ...parts.slice(keep)), exists: keep === parts.length };
      } catch (error: unknown) {
        // Not there, or a cycle: an ancestor further up, then.
        if (!isUnresolvableLinkError(error)) throw error;
      }
    }
    return { canonical: safePath.resolve(target), exists: false };
  }
  return {
    canonicalPath: (target: string) => canonical(target).canonical,
    isUnderRoot: (root: string, candidate: string) => {
      const target = canonical(candidate);
      if (!target.canonical.startsWith(`${canonical(root).canonical}/`)) return 'outside';
      return target.exists ? 'inside' : 'absent';
    },
  };
});

const { kernelRefusal, refuseEscapingLinks, treeChain } = await import('../src/tree-change/link-containment.js');
const FLAVOR_LIST: readonly PathFlavor[] = ['posix', 'win32'];
const { COPY_LINK_ESCAPES_SOURCE_CODE } = await import('../src/tree-change/followed-walk.js');

/** A fresh tree: directories, files, and links, each named relative to {@link ROOT}. */
function plant(entries: Readonly<Record<string, string>>, flavor: PathFlavor = 'posix'): void {
  setKernel(flavor);
  tree.clear();
  listed.length = 0;
  refusedStat.clear();
  kernelFollowed.length = 0;
  tree.set(ROOT, { type: 'dir' });
  for (const [relative, spec] of Object.entries(entries)) {
    const path = safePath.join(ROOT, relative);
    if (spec === 'dir') tree.set(path, { type: 'dir' });
    else if (spec === 'file') tree.set(path, { type: 'file' });
    else tree.set(path, { type: 'link', target: spec.replace(/^-> /, '') });
  }
}

const CHECK = { side: 'source', flavor: 'posix', tree: 'the skill', within: 'the skill', consequence: 'Kept, it would read the installing user\'s files' } as const;
const unit = safePath.join(ROOT, 'skill');
const relocated = { ...CHECK, root: unit, placement: 'relocated' } as const;
const inPlace = { ...CHECK, root: unit, placement: 'in-place' } as const;

function refusalOf(check: Parameters<typeof refuseEscapingLinks>[0]): { code?: string; message: string } | undefined {
  try {
    refuseEscapingLinks(check);
    return undefined;
  } catch (error: unknown) {
    return error as { code?: string; message: string };
  }
}

const SKILL = { skill: 'dir', 'skill/SKILL.md': 'file', 'skill/docs': 'dir', outside: 'dir', 'outside/key.txt': 'file' } as const;

describe('refuseEscapingLinks, a tree that will be relocated', () => {
  it('accepts a tree whose links stay inside, entering each directory once', () => {
    plant({ ...SKILL, 'skill/docs/up.md': '-> ../SKILL.md', 'skill/alias': '-> docs', 'skill/docs/back': '-> ..' });

    expect(refusalOf(relocated)).toBeUndefined();
    expect(listed.toSorted((a, b) => a.localeCompare(b))).toEqual(['skill', 'skill/docs']);
  });

  it.each([
    ['an absolute target', { 'skill/abs': `-> ${safePath.join(ROOT, 'outside', 'key.txt')}` }, 'skill/abs'.slice(6), 'with an absolute target'],
    ['a climb out', { 'skill/docs/out': '-> ../../outside/key.txt' }, 'docs/out', 'to a path outside the skill (../../outside/key.txt)'],
    ['a target through another link', { 'skill/alias': '-> docs', 'skill/via': '-> alias/x.md', 'skill/docs/x.md': 'file' }, 'via', 'passes through another symbolic link (alias)'],
    ['a target that is not there', { 'skill/gone': '-> missing.md' }, 'gone', 'to nothing (missing.md does not exist)'],
  ])('refuses %s, naming the link and why', (_what, links, link, why) => {
    plant({ ...SKILL, ...links });

    const refusal = refusalOf(relocated);

    expect(refusal).toMatchObject({ code: COPY_LINK_ESCAPES_SOURCE_CODE });
    expect(refusal?.message).toContain(`Refusing the skill: ${link} is a symbolic link`);
    expect(refusal?.message).toContain(why);
  });

  // A text naming a link it ends AT walks inside; only the kernel, following it, finds the cycle.
  it('refuses a link the kernel cannot resolve though its text walks inside — a cycle', () => {
    plant({ ...SKILL, 'skill/ping': '-> pong', 'skill/pong': '-> ping' });

    expect(refusalOf(relocated)?.message).toContain('ping is a symbolic link to nothing (pong does not resolve: ELOOP)');
  });

  it('throws a refused probe of a link\'s target as the classified source fault, naming the link', () => {
    plant({ ...SKILL, 'skill/docs/up.md': '-> ../SKILL.md' });
    refusedStat.set(safePath.join(unit, 'docs', 'up.md'), 'EACCES');

    expect(refusalOf(relocated)).toMatchObject({ code: FS_FAULT_CODE, errno: 'EACCES', side: 'source', path: safePath.join(unit, 'docs', 'up.md') });
  });

  it('never enters the directory it is told to skip, and starts at the subtree it is given', () => {
    plant({ ...SKILL, 'skill/.git': 'dir', 'skill/.git/out': '-> ../../outside', 'skill/docs/ok': '-> ../SKILL.md' });

    expect(refusalOf({ ...relocated, skip: safePath.join(unit, '.git') })).toBeUndefined();
    expect(listed).not.toContain('skill/.git');

    listed.length = 0;
    expect(refusalOf({ ...relocated, subtree: safePath.join(unit, 'docs') })).toBeUndefined();
    expect(listed).toEqual(['skill/docs']);
  });
});

// The kernel's lock alone: whether the OS declined or failed to look (a fault, thrown classified by
// the one write-lane catch body) or looked and found nothing to resolve to (the link's refusal) —
// decided by the one errno-table predicate: only the absent class and `ELOOP` mean "nothing there".
// Windows' ambiguous answers are faults — libuv reports four Win32 errors as `EINVAL`, a buffer
// overflow as `ENAMETOOLONG`, and a missing share AND refused credentials alike as `UNKNOWN` — and so
// is an errno no table lists.
describe('kernelRefusal', () => {
  const link = safePath.join(unit, 'docs', 'up.md');

  it.each(['ENOENT', 'ENOTDIR', 'ELOOP'])('calls a link whose probe fails with %s a link to nothing', (code) => {
    plant({ ...SKILL, 'skill/docs/up.md': '-> ../SKILL.md' });
    refusedStat.set(link, code);

    expect(kernelRefusal(relocated, unit, link, '../SKILL.md')).toBe(`to nothing (../SKILL.md does not resolve: ${code}), so where it would lead once the skill is copied cannot be shown`);
  });

  it.each(['EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'ENOSPC', 'EBUSY', 'EAGAIN', 'EIO', 'ESTALE', 'ETIMEDOUT', 'EHOSTDOWN', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ENOTCONN', 'UNKNOWN', 'EINVAL', 'ENAMETOOLONG', 'EWHATEVER'])('throws a probe the OS declined or could not complete with %s as the source fault it is', (code) => {
    plant({ ...SKILL, 'skill/docs/up.md': '-> ../SKILL.md' });
    refusedStat.set(link, code);

    expect(() => kernelRefusal(relocated, unit, link, '../SKILL.md')).toThrow(expect.objectContaining({ code: FS_FAULT_CODE, errno: code, side: 'source', origin: 'content' }));
  });

  it('throws the fault on the side its caller names, never a side of its own', () => {
    plant({ ...SKILL, 'skill/docs/up.md': '-> ../SKILL.md' });
    refusedStat.set(link, 'EACCES');

    expect(() => kernelRefusal({ ...relocated, side: 'environment' }, unit, link, '../SKILL.md')).toThrow(expect.objectContaining({ code: FS_FAULT_CODE, side: 'environment' }));
  });

  it('throws an error that is no filesystem errno raw', () => {
    plant({ ...SKILL, 'skill/docs/up.md': '-> ../SKILL.md' });
    refusedStat.set(link, 'ERR_NOT_AN_ERRNO');

    expect(() => kernelRefusal(relocated, unit, link, '../SKILL.md')).toThrow(expect.objectContaining({ code: 'ERR_NOT_AN_ERRNO' }));
  });
});

describe('refuseEscapingLinks, a tree read in place', () => {
  it('accepts a dangling link aimed inside', () => {
    plant({ ...SKILL, 'skill/later.md': '-> not-yet.md' });

    expect(refusalOf(inPlace)).toBeUndefined();
  });

  // Walked from `docs`, `refs` is reached ONLY through the link: refused only if the link is followed.
  it('follows a link into a sibling directory to judge what is there', () => {
    plant({ ...SKILL, 'skill/docs/alias': '-> ../refs', 'skill/refs': 'dir', 'skill/refs/deep': '-> ../../outside' });

    expect(refusalOf({ ...inPlace, subtree: safePath.join(unit, 'docs') })?.message).toContain('refs/deep is a symbolic link to a path outside the skill');
    expect(listed).toEqual(['skill/docs', 'skill/refs']);
  });

  it('refuses a dangling link aimed outside: it names a path the tree does not own', () => {
    plant({ ...SKILL, 'skill/out': '-> ../outside/none.txt' });

    expect(refusalOf(inPlace)?.message).toContain('out is a symbolic link to a path outside the skill');
  });

  it('accepts a link that resolves inside, whatever its spelling', () => {
    plant({ ...SKILL, 'skill/in': '-> ./docs/../SKILL.md' });

    expect(refusalOf(inPlace)).toBeUndefined();
  });

  // A cloned repository's `\\host\share` link, resolved by a Windows kernel, opens an SMB session and
  // offers the operator's NTLM credentials to that host before any answer comes back. So the text
  // is walked first — every link it meets followed by its OWN text, by lstat and readlink alone —
  // and an absolute, UNC, drive-relative or `\\?\` text is refused before the kernel resolves anything.
  it.each([String.raw`\\attacker\share\x`, String.raw`\\?\UNC\attacker\share`, '//attacker/share/x', '/attacker/x', 'C:attacker', String.raw`D:\attacker`])(
    'refuses a link whose text is %s before the kernel follows it',
    (target) => {
      plant({ ...SKILL, 'skill/smb': `-> ${target}` });

      expect(refusalOf(inPlace)?.message).toContain(`smb is a symbolic link whose target leads through an absolute path (${target})`);
      expect(kernelFollowed).toEqual([]);
    },
  );

  // Planted first, so the walk meets the relative link before the absolute one it leads through.
  it('refuses a relative link that leads through a link to another host before the kernel follows either', () => {
    plant({ skill: 'dir', 'skill/b': '-> a/x', 'skill/a': String.raw`-> \\attacker\share`, 'skill/SKILL.md': 'file' });

    expect(refusalOf(inPlace)?.message).toContain(String.raw`b is a symbolic link whose target leads through an absolute path (\\attacker\share)`);
    expect(kernelFollowed).toEqual([]);
  });

  it('refuses a link whose text climbs out of the tree, even through a link inside it', () => {
    plant({ ...SKILL, 'skill/docs/up': '-> ..', 'skill/docs/out': '-> up/../outside/key.txt' });

    expect(refusalOf(inPlace)?.message).toContain('docs/out is a symbolic link to a path outside the skill (up/../outside/key.txt)');
  });

  // R11-CONTRACT-C1: a real cycle (not `self -> .`) reads nothing in place, like a dangle — never a fault.
  it.each(FLAVOR_LIST)('accepts a real cycle in place, as a link that leads to nothing (%s)', (flavor) => {
    plant({ ...SKILL, 'skill/a': '-> b', 'skill/b': '-> a' }, flavor);

    expect(refusalOf({ ...inPlace, flavor })).toBeUndefined();
  });
});

/** A chain `skill/l00 -> l01 -> … -> l<n-1> -> <end>`. */
function chain(n: number, end: string): Record<string, string> {
  const links: Record<string, string> = {};
  const name = (i: number): string => `l${String(i).padStart(2, '0')}`;
  for (let i = 0; i < n; i++) links[`skill/${name(i)}`] = `-> ${i === n - 1 ? end : name(i + 1)}`;
  return links;
}

// R11-SEC-C1/C2, R11-WIN-C1, R11-SEC-I1: every link a chain leads through is read by its text
// before the kernel is asked anything — on the kernel the fake models, not on the walk's own model.
describe.each(FLAVOR_LIST)('no lane lets the kernel follow a link the walk did not read (%s)', (flavor) => {
  const UNC = String.raw`\\attacker\share`;
  const lanes = [['in place', { ...inPlace, flavor }], ['relocated', { ...relocated, flavor }]] as const;

  it.each(lanes)('refuses a chain of more than 40 links that ends at a network path (%s)', (_lane, check) => {
    plant({ ...SKILL, a: 'dir', ...chain(45, UNC), 'skill/0': '-> l00' }, flavor);

    expect(refusalOf(check)?.code).toBe(COPY_LINK_ESCAPES_SOURCE_CODE);
    expect(kernelFollowed).toEqual([]);
  });

  it.each(lanes)('refuses a chain longer than any kernel follows rather than hand it on (%s)', (_lane, check) => {
    plant({ ...SKILL, ...chain(70, 'SKILL.md') }, flavor);

    expect(refusalOf(check)?.message).toMatch(/more than 63 symbolic links|passes through another symbolic link/);
  });

  // `0` is listed before `z`, so the refusal must name `0` itself: an in-place walk that ACCEPTED
  // it (a reader would then follow it to z's share) would be refused only later, at z. Under POSIX
  // the backslash text is one name and `missing/..` the parent of nothing, so 0 leads nowhere there.
  it.each([String.raw`missing\..\z`, String.raw`SKILL.md\..\z`, 'missing/../z'])('refuses 0 -> %s with z -> a network path, in place, naming 0 under win32', (text) => {
    plant({ ...SKILL, 'skill/0': `-> ${text}`, 'skill/z': `-> ${UNC}` }, flavor);

    expect(refusalOf({ ...inPlace, flavor })?.message).toContain(`Refusing the skill: ${flavor === 'win32' ? '0' : 'z'} is a symbolic link whose target leads through an absolute path (${UNC})`);
    expect(kernelFollowed).toEqual([]);
  });

  it('refuses a -> b -> a network path through the install lane, b judged before the kernel follows a', () => {
    plant({ skill: 'dir', 'skill/a': '-> b', 'skill/b': `-> ${UNC}`, 'skill/SKILL.md': 'file' }, flavor);

    expect(refusalOf({ ...relocated, flavor })?.message).toMatch(/is a symbolic link (whose target passes through another symbolic link|whose target leads through an absolute path)/);
    expect(kernelFollowed).toEqual([]);
  });

  // The `#ref:subpath` lane asks the same resolver of the subpath itself. Under POSIX a backslash
  // is part of a name and `nope/..` is the parent of nothing: those two lead nowhere there.
  it.each([[String.raw`README.md\..\smb`, 'nothing'], ['nope/../smb', 'nothing'], ['l00', 'refused']] as const)('answers a subpath that leads through %s toward a network path unresolved', (text, posixAnswer) => {
    plant({ ...SKILL, 'skill/README.md': 'file', 'skill/smb': `-> ${UNC}`, 'skill/skills': `-> ${text}`, ...chain(45, 'smb') }, flavor);

    expect(treeChain(unit, safePath.join(unit, 'skills', 'x'), flavor)).toMatchObject({ kind: flavor === 'win32' ? 'refused' : posixAnswer });
    expect(kernelFollowed).toEqual([]);
  });
});

/**
 * The one link-chain resolver, under BOTH flavors on every host: a fake filesystem answers `lstat`
 * and `readlink`, and the resolver must never need anything else. Each case that hands a network
 * text to a Windows kernel is a case the resolver must refuse before a kernel is asked — so a
 * refusal here is the whole guarantee, and a `resolved` answer is what the kernel would be handed.
 */
import { describe, expect, it } from 'vitest';

import { toForwardSlash } from '../src/path-core.js';
import { type ChainRule, MAX_LINK_HOPS, type PathFlavor, type PlaceKind, untrustedTextRefusal, walkLinkChain } from '../src/tree-change/link-chain.js';

/** A tree: `path -> text` for a link, `dir` or `file` for anything else. Paths are absolute, forward-slashed. */
type FakeTree = Readonly<Record<string, string>>;

/** The probe a fake tree answers, and every path it was asked about. */
function probeOf(tree: FakeTree, flavor: PathFlavor): { kindAt: (p: string) => PlaceKind; textAt: (p: string) => string; asked: string[] } {
  const key = (path: string): string => (flavor === 'win32' ? path.toLowerCase() : path);
  const entries = new Map(Object.entries(tree).map(([path, value]) => [key(path), value]));
  const asked: string[] = [];
  return {
    asked,
    kindAt: (path) => {
      asked.push(path);
      const value = entries.get(key(path));
      if (value === undefined) return 'absent';
      if (value === 'dir') return 'directory';
      if (value === 'file') return 'file';
      return 'link';
    },
    textAt: (path) => {
      const value = entries.get(key(path));
      if (value === undefined || value === 'dir' || value === 'file') throw new Error(`not a link: ${path}`);
      return value.slice('-> '.length);
    },
  };
}

const ROOTS: Readonly<Record<PathFlavor, string>> = { posix: '/r', win32: 'C:/r' };

/** A tree under the flavor's root: keys are root-relative. */
function under(flavor: PathFlavor, tree: FakeTree): FakeTree {
  return Object.fromEntries([[ROOTS[flavor], 'dir'], ...Object.entries(tree).map(([path, value]) => [`${ROOTS[flavor]}/${path}`, value])]);
}

function walk(flavor: PathFlavor, tree: FakeTree, start: string, outside: ChainRule['outside'] = 'refuse'): ReturnType<typeof walkLinkChain> {
  return walkLinkChain(`${ROOTS[flavor]}/${start}`, { flavor, root: ROOTS[flavor], outside }, probeOf(under(flavor, tree), flavor));
}

/** A chain `l00 -> l01 -> … -> l<n-1> -> <end>`. */
function chain(n: number, end: string): FakeTree {
  const tree: Record<string, string> = {};
  const name = (i: number): string => `l${String(i).padStart(2, '0')}`;
  for (let i = 0; i < n; i++) tree[name(i)] = `-> ${i === n - 1 ? end : name(i + 1)}`;
  return tree;
}

const FLAVORS: readonly PathFlavor[] = ['posix', 'win32'];

describe('walkLinkChain', () => {
  it.each(FLAVORS)('resolves a chain of links that stays inside to its real path (%s)', (flavor) => {
    const verdict = walk(flavor, { docs: 'dir', 'docs/a.md': 'file', alias: '-> docs', 'x.md': '-> alias/a.md' }, 'x.md');
    expect(verdict).toEqual({ kind: 'resolved', path: `${ROOTS[flavor]}/docs/a.md`, final: 'file' });
  });

  it.each([String.raw`\\attacker\share`, String.raw`\\?\UNC\attacker\share`, String.raw`\\.\pipe\x`, '//attacker/share'])('refuses a network text %s under win32, in both rules', (text) => {
    for (const outside of ['refuse', 'follow'] as const) {
      expect(walk('win32', { smb: `-> ${text}` }, 'smb', outside)).toMatchObject({ kind: 'refused', refusal: { why: 'network', text } });
    }
  });

  it('reads a backslash as a character of a name under posix in the user\'s own tree: a relative name, not a host', () => {
    expect(walk('posix', { smb: String.raw`-> \\attacker\share` }, 'smb', 'follow')).toMatchObject({ kind: 'nothing', cause: 'absent' });
  });

  // An untrusted tree may be read on either host: a clone made on POSIX is installed on Windows.
  it.each([[String.raw`\\attacker\share`, 'network'], ['C:attacker', 'drive-relative'], [String.raw`D:\x`, 'absolute'], ['/etc/x', 'absolute']] as const)(
    'refuses %s in an untrusted tree under posix too, by the other flavor\'s rule (%s)',
    (text, why) => {
      expect(walk('posix', { l: `-> ${text}` }, 'l')).toMatchObject({ kind: 'refused', refusal: { why, text } });
      expect(untrustedTextRefusal(text)).toBe(why);
    },
  );

  it('answers a relative text no refusal by its text alone', () => {
    expect(untrustedTextRefusal('../docs/a.md')).toBeUndefined();
    expect(untrustedTextRefusal(String.raw`docs\a.md`)).toBeUndefined();
  });

  it('walks a tree that lives on a share under win32, but never a link to one', () => {
    const tree = { '//fileserver/team/repo': 'dir', '//fileserver/team/repo/a.md': 'file', '//fileserver/team/repo/l': String.raw`-> \\attacker\share` };
    const probe = probeOf(tree, 'win32');
    const rule = { flavor: 'win32', root: String.raw`\\fileserver\team\repo`, outside: 'refuse' } as const;
    expect(walkLinkChain(String.raw`\\fileserver\team\repo\a.md`, rule, probe)).toEqual({ kind: 'resolved', path: '//fileserver/team/repo/a.md', final: 'file' });
    expect(walkLinkChain(String.raw`\\fileserver\team\repo\l`, rule, probe)).toMatchObject({ kind: 'refused', refusal: { why: 'network' } });
  });

  it('follows a volume-GUID text under win32 in the user\'s own tree, and refuses it in an untrusted one', () => {
    const volume = String.raw`\\?\Volume{12345678-aaaa-bbbb-cccc-1234567890ab}\data`;
    const tree = { ...under('win32', { j: `-> ${volume}` }), '//?/Volume{12345678-aaaa-bbbb-cccc-1234567890ab}/data': 'dir' };
    const probe = probeOf(tree, 'win32');
    expect(walkLinkChain('C:/r/j', { flavor: 'win32', root: 'C:/r', outside: 'follow' }, probe)).toMatchObject({ kind: 'resolved', final: 'directory' });
    expect(walkLinkChain('C:/r/j', { flavor: 'win32', root: 'C:/r', outside: 'refuse' }, probe)).toMatchObject({ kind: 'refused', refusal: { why: 'absolute' } });
  });

  // R11-SEC-C1: the walk used to stop following at 40 and answer "inside"; a Windows kernel follows 63.
  it.each(FLAVORS)('follows a chain of more than 40 links to its network end, and refuses it (%s)', (flavor) => {
    const end = flavor === 'win32' ? String.raw`\\attacker\share` : '/etc';
    expect(walk(flavor, chain(45, end), 'l00')).toMatchObject({ kind: 'refused', refusal: { why: flavor === 'win32' ? 'network' : 'absolute' } });
  });

  it.each(FLAVORS)('refuses a chain longer than any kernel follows — never answers it (%s)', (flavor) => {
    expect(walk(flavor, { ...chain(MAX_LINK_HOPS + 1, 'end.md'), 'end.md': 'file' }, 'l00')).toMatchObject({ kind: 'refused', refusal: { why: 'hop-limit' } });
  });

  // R11-CONTRACT-C1: a cycle is every text read and local — the kernel can only answer ELOOP. It
  // resolves to nothing, as a dangling link does, told apart from a chain too long to finish.
  it.each(FLAVORS)('answers a real cycle nothing, in every rule (%s)', (flavor) => {
    for (const outside of ['refuse', 'follow'] as const) {
      expect(walk(flavor, { a: '-> b', b: '-> a' }, 'a', outside)).toMatchObject({ kind: 'nothing', cause: 'cycle' });
      expect(walk(flavor, { d: 'dir', 'd/x': '-> ../y', y: '-> d/x' }, 'y', outside)).toMatchObject({ kind: 'nothing', cause: 'cycle' });
    }
  });

  it.each(FLAVORS)('refuses a chain that grows at every hop — no cycle, so no answer (%s)', (flavor) => {
    expect(walk(flavor, { a: '-> a/x' }, 'a')).toMatchObject({ kind: 'refused', refusal: { why: 'hop-limit' } });
  });

  it.each(FLAVORS)('reads a cycle\'s every text before answering: one network hop in it is refused (%s)', (flavor) => {
    expect(walk(flavor, { a: '-> b', b: '-> c', c: String.raw`-> \\attacker\share` }, 'a')).toMatchObject({ kind: 'refused', refusal: { why: 'network' } });
  });

  // R11-SEC-C2 / R11-WIN-C1: Windows collapses `..` in a link text by string before it reparses.
  it.each([[String.raw`missing\..\z`], [String.raw`SKILL.md\..\z`], ['missing/../z']])('collapses %s by string under win32 and follows z to its network text', (text) => {
    const tree = { 'SKILL.md': 'file', z: String.raw`-> \\attacker\share`, a: `-> ${text}` };
    expect(walk('win32', tree, 'a')).toMatchObject({ kind: 'refused', refusal: { why: 'network' } });
  });

  it('resolves missing/../z and file/../z physically under posix: nothing there', () => {
    const tree = { 'SKILL.md': 'file', z: '-> /etc', a: '-> missing/../z', b: '-> SKILL.md/../z' };
    expect(walk('posix', tree, 'a')).toMatchObject({ kind: 'nothing' });
    expect(walk('posix', tree, 'b')).toMatchObject({ kind: 'nothing' });
  });

  it('reads L/../z beside L under win32, and below L\'s target under posix', () => {
    const tree = { sub: 'dir', 'sub/deep': 'dir', 'sub/z': 'file', L: '-> sub/deep', z: String.raw`-> \\attacker\share`, a: '-> L/../z' };
    expect(walk('win32', tree, 'a')).toMatchObject({ kind: 'refused', refusal: { why: 'network' } });
    expect(walk('posix', tree, 'a')).toEqual({ kind: 'resolved', path: '/r/sub/z', final: 'file' });
  });

  // R11-SEC-I1: a chain whose LAST hop is a link is read to its end, never left to the kernel.
  it('follows a -> b -> network to the end (win32)', () => {
    expect(walk('win32', { a: '-> b', b: String.raw`-> \\attacker\share` }, 'a')).toMatchObject({ kind: 'refused', refusal: { why: 'network', link: 'C:/r/b' } });
  });

  it.each(FLAVORS)('refuses an absolute text in an untrusted tree, and walks it in the user\'s own (%s)', (flavor) => {
    const outsideRoot = flavor === 'win32' ? 'C:/out' : '/out';
    const tree = { ...under(flavor, { abs: `-> ${outsideRoot}/x` }), [outsideRoot]: 'dir', [`${outsideRoot}/x`]: String.raw`-> \\attacker\share` };
    const probe = probeOf(tree, flavor);
    expect(walkLinkChain(`${ROOTS[flavor]}/abs`, { flavor, root: ROOTS[flavor], outside: 'refuse' }, probe)).toMatchObject({ kind: 'refused', refusal: { why: 'absolute' } });
    // Followed in the user's own tree — and the later hop's network text is still caught (win32), or resolved (posix: a name).
    const followed = walkLinkChain(`${ROOTS[flavor]}/abs`, { flavor, root: ROOTS[flavor], outside: 'follow' }, probe);
    expect(followed).toMatchObject(flavor === 'win32' ? { kind: 'refused', refusal: { why: 'network' } } : { kind: 'nothing' });
  });

  it.each(FLAVORS)('refuses a climb above the root in an untrusted tree, without probing outside (%s)', (flavor) => {
    const probe = probeOf(under(flavor, { up: '-> ../../etc' }), flavor);
    expect(walkLinkChain(`${ROOTS[flavor]}/up`, { flavor, root: ROOTS[flavor], outside: 'refuse' }, probe)).toMatchObject({ kind: 'refused', refusal: { why: 'climbs-out', link: `${ROOTS[flavor]}/up` } });
    expect(probe.asked.every((path) => toForwardSlash(path).startsWith(ROOTS[flavor]))).toBe(true);
  });

  // A root more than one component deep: a win32 splice re-walks the whole name, and must start
  // again from the ROOT, not from the drive — or every relative link reads as climbing out.
  it.each(FLAVORS)('keeps a relative link inside a deep root inside it (%s)', (flavor) => {
    const root = flavor === 'win32' ? 'C:/a/b/r' : '/a/b/r';
    const tree = { [root]: 'dir', [`${root}/docs`]: 'dir', [`${root}/docs/x.md`]: 'file', [`${root}/l`]: '-> docs/x.md', [`${root}/c1`]: '-> c2', [`${root}/c2`]: '-> c1' };
    const probe = probeOf(tree, flavor);
    expect(walkLinkChain(`${root}/l`, { flavor, root, outside: 'refuse' }, probe)).toEqual({ kind: 'resolved', path: `${root}/docs/x.md`, final: 'file' });
    expect(walkLinkChain(`${root}/c1`, { flavor, root, outside: 'refuse' }, probe)).toMatchObject({ kind: 'nothing', cause: 'cycle' });
  });

  it('refuses a drive-relative text under win32', () => {
    expect(walk('win32', { d: '-> D:secret' }, 'd')).toMatchObject({ kind: 'refused', refusal: { why: 'drive-relative' } });
  });

  it.each(FLAVORS)('answers nothing for a dangling link and for a file used as a directory (%s)', (flavor) => {
    expect(walk(flavor, { gone: '-> not-there' }, 'gone')).toMatchObject({ kind: 'nothing', cause: 'absent' });
    expect(walk(flavor, { 'f.md': 'file', g: '-> f.md/x' }, 'g')).toMatchObject({ kind: 'nothing', cause: 'absent' });
  });
});

/**
 * How `cloneGitSource` reads the committed link texts it judges before checkout, against a git
 * whose output the test writes byte for byte.
 *
 * The paths come from `git ls-tree -z` and the texts from ONE `git cat-file --batch`, both read as
 * bytes. A blob that is not valid UTF-8 changes length in a UTF-8 decode, and a parser that frames
 * the stream by the declared sizes then reads an attacker's planted `<oid> blob <n>` header as the
 * next object — judging a benign text in place of a `\\host\share` one (R12-SEC-C1). Every
 * framing fault here, and every path or text that is not UTF-8, must refuse the clone before
 * `read-tree` writes a single file.
 *
 * `spawnSync` is mocked: nothing here touches the filesystem or the network.
 */
import { COPY_LINK_ESCAPES_SOURCE_CODE, type HOST_PATH_FLAVOR } from '@vibe-agent-toolkit/utils';
import { parseGitUrl } from '@vibe-agent-toolkit/utils/git';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cloneGitSource, GIT_CLONE_FAILED_CODE, GIT_SUBPATH_INVALID_CODE } from '../../src/skill-source/git-clone.js';

/** Whose path rules the clone's edge binds. */
type PathFlavor = typeof HOST_PATH_FLAVOR;

const host = vi.hoisted(() => ({ flavor: 'posix' as PathFlavor }));

/** The one spawn every git call goes through, replaced before any module loads: no process can start. */
const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));
vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Read at each use, so one test can bind the edge to win32 on any host.
  get HOST_PATH_FLAVOR(): PathFlavor {
    return host.flavor;
  },
}));

const COMMIT = 'c'.repeat(40);
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const NUL = String.fromCodePoint(0);
const UNC = String.raw`\\attacker\share`;

/** One committed link: its path (bytes when it is not UTF-8), blob and the bytes the blob holds. */
interface FakeLink {
  readonly path: string | Buffer;
  readonly oid: string;
  readonly bytes: Buffer;
}

/** `cat-file --batch`'s honest answer for `links`: `<oid> blob <size> LF <bytes> LF` each. */
function honestBatch(links: readonly FakeLink[]): Buffer {
  return Buffer.concat(links.flatMap((link) => [Buffer.from(`${link.oid} blob ${link.bytes.length.toString()}\n`), link.bytes, Buffer.from('\n')]));
}

/** What the fake git answers, per subcommand; `tree` and `batch` replace the honest `ls-tree` and `cat-file --batch` output. */
interface FakeGit {
  readonly links: readonly FakeLink[];
  readonly tree?: Buffer;
  readonly batch?: Buffer;
  /** A subcommand that fails, and what it says on stderr. */
  readonly failing?: { readonly subcommand: string; readonly stderr: string };
}

/** The git invocations the clone made, by their argv. */
let calls: string[][];

/** `ls-tree -r -z`'s honest answer for `links`: one `120000 blob <oid> TAB <path> NUL` record each, the path as bytes. */
function honestTree(links: readonly FakeLink[]): Buffer {
  return Buffer.concat(links.map((link) => Buffer.concat([Buffer.from(`120000 blob ${link.oid}\t`), Buffer.isBuffer(link.path) ? link.path : Buffer.from(link.path), Buffer.from(NUL)])));
}

function installGit(fake: FakeGit): void {
  calls = [];
  spawnSyncMock.mockImplementation((_bin: string, args: readonly string[], options: { readonly encoding?: BufferEncoding }) => {
    calls.push([...args]);
    // What `spawnSync` hands back: the bytes decoded by the spawn's `encoding`, as the real one does.
    const ok = (stdout: Buffer | string): unknown => ({ status: 0, stdout: (Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)).toString(options.encoding ?? 'utf8'), stderr: '' });
    const failed = (stderr: string): unknown => ({ status: 1, stdout: '', stderr: Buffer.from(stderr).toString(options.encoding ?? 'utf8') });
    if (fake.failing !== undefined && args.includes(fake.failing.subcommand)) return failed(fake.failing.stderr);
    if (args.includes('clone')) return ok('');
    if (args[0] === 'rev-parse') return ok(`${COMMIT}\n`);
    if (args[0] === 'ls-tree') return ok(fake.tree ?? honestTree(fake.links));
    if (args[0] === 'cat-file' && args[1] === '--batch') return ok(fake.batch ?? honestBatch(fake.links));
    return failed(`unexpected git ${args.join(' ')}`);
  });
}

function clone(subpath = 'plugins/foo'): () => unknown {
  return () => cloneGitSource(parseGitUrl(`https://example.invalid/r.git#main:${subpath}`), '/vat-git-clone-link-texts/never-created');
}

/** The clone refused, and `read-tree` — the checkout — never ran. */
function expectRefusedBeforeCheckout(run: () => unknown, expected: Record<string, unknown>): void {
  expect(run).toThrow(expect.objectContaining(expected));
  expect(calls.some((args) => args[0] === 'read-tree')).toBe(false);
}

const link = (path: string, oid: string, bytes: Buffer | string): FakeLink => ({ path, oid, bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) });

beforeEach(() => {
  spawnSyncMock.mockReset();
  host.flavor = 'posix';
});

describe('cloneGitSource reads committed link texts as the blobs\' bytes', () => {
  // R12-SEC-C1, verbatim: six 0xFF bytes inflate by 12 in a UTF-8 decode, landing the size check
  // on a planted LF, after which the planted header frames `b` as the benign `ok`.
  it('refuses the forged-header blob of R12-SEC-C1 before checkout, never judging b as "ok"', () => {
    const tail = Buffer.from('x blob 2\nok');
    const filler = Buffer.alloc(20, 0x61);
    const a = Buffer.concat([Buffer.alloc(6, 0xff), filler, Buffer.from('\n'), tail]);
    expect(a.indexOf(0x0a)).toBe(a.length - 12);
    installGit({ links: [link('plugins/foo/a', OID_A, a), link('plugins/foo/b', OID_B, UNC)] });
    expectRefusedBeforeCheckout(clone(), { code: COPY_LINK_ESCAPES_SOURCE_CODE, message: expect.stringContaining('"plugins/foo/a" is a symbolic link whose text is not portable') });
  });

  it.for([
    ['a blob of 0xFF bytes', Buffer.from([0xff, 0xff])],
    // Same byte length after the decode (one U+FFFD for three bytes): a length check alone passes it.
    ['a truncated four-byte sequence', Buffer.from([0xf0, 0x9f, 0x98])],
    // An encoded surrogate: `toString('utf8')` decodes it to U+FFFD x3 rather than refusing it.
    ['an encoded surrogate', Buffer.from([0xed, 0xa0, 0x80])],
  ] as const)('refuses %s as a text that is not portable, before checkout', ([, bytes]) => {
    installGit({ links: [link('plugins/foo/a', OID_A, bytes)] });
    expectRefusedBeforeCheckout(clone(), { code: COPY_LINK_ESCAPES_SOURCE_CODE, message: expect.stringContaining('"plugins/foo/a" is a symbolic link whose text is not portable') });
  });

  it('shows a text that is not UTF-8 by its bytes, never by a lossy decode', () => {
    installGit({ links: [link('plugins/foo/a', OID_A, Buffer.from([0x6f, 0x6b, 0xff]))] });
    expectRefusedBeforeCheckout(clone(), { message: expect.stringContaining(String.raw`not portable ("ok\xff")`) });
  });

  it('judges a valid U+FFFD as the text it is: UTF-8, so checked out, not refused as unportable', () => {
    installGit({ links: [link('plugins/foo/a', OID_A, `ok${String.fromCodePoint(0xff_fd)}`)] });
    // The fake answers `read-tree` with a failure: reaching it is the link passing its judgment.
    expect(clone()).toThrow(expect.objectContaining({ code: GIT_CLONE_FAILED_CODE, message: expect.stringMatching(/Failed to check out/) }));
  });

  it('reads every link text in ONE cat-file spawn, a text that is not UTF-8 among them', () => {
    installGit({ links: [link('plugins/foo/a', OID_A, 'SKILL.md'), link('plugins/foo/b', OID_B, Buffer.from([0xff]))] });
    expectRefusedBeforeCheckout(clone(), { code: COPY_LINK_ESCAPES_SOURCE_CODE, message: expect.stringContaining('"plugins/foo/b" is a symbolic link whose text is not portable') });
    expect(calls.filter((args) => args[0] === 'cat-file')).toEqual([['cat-file', '--batch']]);
  });

  it('judges a planted header inside a valid UTF-8 blob as that blob\'s own text', () => {
    const a = `x\n${OID_B} blob 2\nok`;
    installGit({ links: [link('plugins/foo/a', OID_A, a), link('plugins/foo/b', OID_B, UNC)] });
    expectRefusedBeforeCheckout(clone(), { code: COPY_LINK_ESCAPES_SOURCE_CODE, message: expect.stringContaining('"plugins/foo/b" is a symbolic link whose target leads through a network path') });
  });
});

describe('cloneGitSource reads committed paths as the bytes git holds', () => {
  it.for([
    ['a 0xFF byte', Buffer.concat([Buffer.from('plugins/'), Buffer.from([0xff])]), String.raw`"plugins/\xff"`],
    ['an encoded surrogate', Buffer.concat([Buffer.from('x'), Buffer.from([0xed, 0xa0, 0x80])]), String.raw`"x\xed\xa0\x80"`],
  ] as const)('refuses a commit holding a path with %s, before checkout, showing its bytes', ([, path, shown]) => {
    installGit({ links: [link(path, OID_A, 'SKILL.md')] });
    expectRefusedBeforeCheckout(clone(), { code: GIT_CLONE_FAILED_CODE, message: expect.stringContaining(`holds a path that is not UTF-8 (${shown})`) });
  });

  it('refuses a non-UTF-8 path that is not a link too: the checkout writes every path', () => {
    installGit({ links: [], tree: Buffer.concat([Buffer.from(`100644 blob ${OID_A}\tdocs/`), Buffer.from([0xc3, 0x28]), Buffer.from(NUL)]) });
    expectRefusedBeforeCheckout(clone(), { code: GIT_CLONE_FAILED_CODE, message: expect.stringContaining(String.raw`not UTF-8 ("docs/\xc3(")`) });
  });

  it('shows a path and a text by escapes, never as the control or bidi characters they hold', () => {
    const rlo = String.fromCodePoint(0x20_2e);
    const esc = String.fromCodePoint(0x1b);
    installGit({ links: [link(`plugins/${rlo}evil`, OID_A, `${UNC}${esc}[2J`)] });
    // Built from a backslash rather than written as `String.raw`: a transform may cook its `\u` escapes.
    const bs = '\\';
    const refusal = expect.stringContaining(
      `"plugins/${bs}u202eevil" is a symbolic link whose target leads through a network path ("${bs.repeat(4)}attacker${bs.repeat(2)}share${bs}u001b[2J")`,
    );
    expectRefusedBeforeCheckout(clone(), { code: COPY_LINK_ESCAPES_SOURCE_CODE, message: refusal });
    for (const raw of [esc, rlo]) expect(clone()).toThrow(expect.objectContaining({ message: expect.not.stringContaining(raw) }));
  });

  it.for([
    // Escapes spelled after the backslash, which is prefixed below: a transform may cook `\u` in `String.raw`.
    // The classification itself is pinned in utils' `shown-text` suite; these pin that the path reaches it.
    ['a C1 CSI', 0x9b, 'u009b'],
    ['a tag character', 0xe_00_41, 'u{e0041}'],
  ] as const)('shows %s in a path by its escape', ([, code, spelled]) => {
    const character = String.fromCodePoint(code);
    const escape = `\\${spelled}`;
    installGit({ links: [link(`plugins/a${character}b`, OID_A, UNC)] });
    const run = clone();
    expect(run).toThrow(expect.objectContaining({ message: expect.stringContaining(`"plugins/a${escape}b" is a symbolic link`) }));
    expect(run).toThrow(expect.objectContaining({ message: expect.not.stringContaining(character) }));
  });

  it('quotes git\'s stderr line by line, unshowables escaped, its own quotes and backslashes and CRLF as lines', () => {
    const csi = String.fromCodePoint(0x9b);
    installGit({ links: [], failing: { subcommand: 'read-tree', stderr: `error: invalid path 'C:\\x"${csi}2J'\r\nfatal: stop\r\n` } });
    const run = clone();
    expect(run).toThrow(expect.objectContaining({ message: `Failed to check out the cloned commit: error: invalid path 'C:\\x"\\u009b2J'\nfatal: stop` }));
  });

  // Every lane git's words reach a message by: the clone (a remote's own words), and a byte read of
  // the object store, whose stderr crosses the hex transport.
  it.for([
    ['clone', 'Clone failed:\n'],
    ['ls-tree', "Failed to list the cloned commit's tree: "],
    ['cat-file', "Failed to read the cloned repository's link texts: "],
  ] as const)('escapes a control and a bidi character in what %s said', ([subcommand, prefix]) => {
    const esc = String.fromCodePoint(0x1b);
    const rlo = String.fromCodePoint(0x20_2e);
    installGit({ links: [link('plugins/foo/a', OID_A, 'SKILL.md')], failing: { subcommand, stderr: `remote: ${esc}]0;x${rlo}y` } });
    let thrown: unknown;
    try {
      clone()();
    } catch (error) {
      thrown = error;
    }
    const { message } = thrown as Error;
    const bs = '\\';
    expect(message).toContain(`${prefix}remote: ${bs}u001b]0;x${bs}u202ey`);
    expect(message).not.toContain(esc);
    expect(message).not.toContain(rlo);
  });

  it('quotes only the end of a flood of stderr, saying how much it left out', () => {
    installGit({ links: [], failing: { subcommand: 'read-tree', stderr: `${'x'.repeat(10_000)}\nfatal: the cause` } });
    const run = clone();
    expect(run).toThrow(expect.objectContaining({ message: expect.stringMatching(/\[5921 earlier characters omitted\]\nx+\nfatal: the cause$/) }));
  });

  it('shows an unassigned code point in a path by its escape', () => {
    installGit({ links: [link(`plugins/a${String.fromCodePoint(0x20_65)}b`, OID_A, UNC)] });
    const bs = '\\';
    expect(clone()).toThrow(expect.objectContaining({ message: expect.stringContaining(`"plugins/a${bs}u2065b" is a symbolic link`) }));
  });

  it('judges a link whose path is valid non-ASCII UTF-8 by that path', () => {
    installGit({ links: [link('plugins/foo/é', OID_A, UNC)] });
    expectRefusedBeforeCheckout(clone(), { code: COPY_LINK_ESCAPES_SOURCE_CODE, message: expect.stringContaining('"plugins/foo/é" is a symbolic link whose target leads through a network path') });
  });

  it.for([
    ['a record with no TAB', `120000 blob ${OID_A} plugins/foo/a${NUL}`],
    ['a record with no closing NUL', `120000 blob ${OID_A}\tplugins/foo/a`],
    ['a record whose object is not an object name', `120000 blob xyz\tplugins/foo/a${NUL}`],
  ] as const)('refuses a listing holding %s rather than skipping it', ([, tree]) => {
    installGit({ links: [], tree: Buffer.from(tree) });
    expectRefusedBeforeCheckout(clone(), { code: GIT_CLONE_FAILED_CODE, message: expect.stringMatching(/Failed to list the cloned commit's tree: git wrote a record/) });
  });
});

describe('cloneGitSource refuses a cat-file stream that does not frame exactly the asked objects', () => {
  const links = [link('plugins/foo/a', OID_A, 'SKILL.md'), link('plugins/foo/b', OID_B, 'SKILL.md')];
  const failed = (why: RegExp): Record<string, unknown> => ({ code: GIT_CLONE_FAILED_CODE, message: expect.stringMatching(why) });

  it('refuses fewer objects than links (object-count mismatch)', () => {
    installGit({ links, batch: honestBatch(links.slice(0, 1)) });
    expectRefusedBeforeCheckout(clone(), failed(/returned 1 of 2 objects/));
  });

  it('refuses a short read: an object whose bytes end before its header says', () => {
    installGit({ links: links.slice(0, 1), batch: Buffer.from(`${OID_A} blob 9\nSKILL.md\n`) });
    expectRefusedBeforeCheckout(clone(), failed(/"plugins\/foo\/a": its bytes do not end where its header says/));
  });

  it('refuses leftover bytes after the last asked object', () => {
    installGit({ links: links.slice(0, 1), batch: Buffer.concat([honestBatch(links.slice(0, 1)), Buffer.from(`${OID_B} blob 2\nok\n`)]) });
    expectRefusedBeforeCheckout(clone(), failed(/bytes after the last link/));
  });

  it.for([
    ['names another object', `${OID_B} blob 8`],
    ['is not a blob', `${OID_A} tree 8`],
    ['reports the object missing', `${OID_A} missing`],
    ['spells its size loosely', `${OID_A} blob +8`],
  ] as const)('refuses a header that %s', ([, header]) => {
    installGit({ links: links.slice(0, 1), batch: Buffer.from(`${header}\nSKILL.md\n`) });
    expectRefusedBeforeCheckout(clone(), failed(/"plugins\/foo\/a": its header .* is not/));
  });
});

describe('cloneGitSource judges committed link texts by the shared untrusted-link rule', () => {
  it.for([
    ['a NUL', `ok${NUL}${UNC}`],
    ['a component ending in a space', '.. /.. /x'],
    ['a component ending in a dot', 'docs./x'],
  ] as const)('refuses a text holding %s as not portable, on every host', ([, text]) => {
    installGit({ links: [link('plugins/foo/a', OID_A, text)] });
    expectRefusedBeforeCheckout(clone(), { code: COPY_LINK_ESCAPES_SOURCE_CODE, message: expect.stringContaining('"plugins/foo/a" is a symbolic link whose text is not portable') });
  });

  it('refuses a text that climbs above the repository by either flavor\'s separators', () => {
    installGit({ links: [link('plugins/foo/a', OID_A, String.raw`..\../..\x`)] });
    expectRefusedBeforeCheckout(clone(), { code: COPY_LINK_ESCAPES_SOURCE_CODE, message: expect.stringContaining('"plugins/foo/a" is a symbolic link to a path outside the clone') });
  });

  // R12-CONTRACT-I4 part 2: Windows names `Skills` and `skills` the same directory.
  it.for([
    ['win32', GIT_SUBPATH_INVALID_CODE],
    ['posix', COPY_LINK_ESCAPES_SOURCE_CODE],
  ] as const)('matches the subpath against an escaping link case-blind only under %s', ([flavor, code]) => {
    host.flavor = flavor;
    installGit({ links: [link('skills', OID_A, UNC)] });
    expectRefusedBeforeCheckout(clone('Skills/deeper'), { code });
  });

  it('folds the subpath ordinally under win32, never by toLowerCase of the whole string', () => {
    host.flavor = 'win32';
    // The Kelvin sign (U+212A) lowercases to `k`, so `toLowerCase` calls `<Kelvin>ills` and `kills`
    // one name; Windows upcases `k` to `K` (U+004B) and leaves the Kelvin sign as it is — two names.
    const kelvin = String.fromCodePoint(0x21_2a);
    installGit({ links: [link('kills', OID_A, UNC)] });
    expectRefusedBeforeCheckout(clone(`${kelvin}ills/deeper`), { code: COPY_LINK_ESCAPES_SOURCE_CODE });
    installGit({ links: [link('kills', OID_A, UNC)] });
    expectRefusedBeforeCheckout(clone('KILLS/deeper'), { code: GIT_SUBPATH_INVALID_CODE });
  });
});

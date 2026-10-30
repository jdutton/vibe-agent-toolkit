/**
 * How `cloneGitSource` reads the committed link texts it judges before checkout, against a git
 * whose output the test writes byte for byte.
 *
 * The texts come from `git cat-file --batch`, whose stdout `runGit` hands back decoded as UTF-8.
 * A blob that is not valid UTF-8 changes length in that decode, and a parser that frames the
 * stream by the declared sizes then reads an attacker's planted `<oid> blob <n>` header as the
 * next object — judging a benign text in place of a `\\host\share` one (R12-SEC-C1). Every
 * framing fault here must refuse the clone before `read-tree` writes a single link.
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

/** One committed link: its path, blob and the bytes the blob holds. */
interface FakeLink {
  readonly path: string;
  readonly oid: string;
  readonly bytes: Buffer;
}

/** `cat-file --batch`'s honest answer for `links`: `<oid> blob <size> LF <bytes> LF` each. */
function honestBatch(links: readonly FakeLink[]): Buffer {
  return Buffer.concat(links.flatMap((link) => [Buffer.from(`${link.oid} blob ${link.bytes.length.toString()}\n`), link.bytes, Buffer.from('\n')]));
}

/** What the fake git answers, per subcommand; `batch` replaces the honest `cat-file --batch` output. */
interface FakeGit {
  readonly links: readonly FakeLink[];
  readonly batch?: Buffer;
}

/** The git invocations the clone made, by their argv. */
let calls: string[][];

function installGit(fake: FakeGit): void {
  calls = [];
  spawnSyncMock.mockImplementation((_bin: string, args: readonly string[]) => {
    calls.push([...args]);
    const ok = (stdout: Buffer | string): unknown => ({ status: 0, stdout, stderr: '' });
    if (args.includes('clone')) return ok('');
    if (args[0] === 'rev-parse') return ok(`${COMMIT}\n`);
    if (args[0] === 'ls-tree') return ok(fake.links.map((link) => `120000 blob ${link.oid}\t${link.path}${NUL}`).join(''));
    if (args[0] === 'cat-file' && args[1] === '--batch') return ok(fake.batch ?? honestBatch(fake.links));
    if (args[0] === 'cat-file' && args[1] === 'blob') return ok(fake.links.find((link) => link.oid === args[2])?.bytes ?? '');
    return { status: 1, stdout: '', stderr: `unexpected git ${args.join(' ')}` };
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
    expectRefusedBeforeCheckout(clone(), { code: COPY_LINK_ESCAPES_SOURCE_CODE, message: expect.stringContaining('plugins/foo/a is a symbolic link whose text is not portable') });
  });

  it.for([
    ['a blob of 0xFF bytes', Buffer.from([0xff, 0xff])],
    // Same byte length after the decode (one U+FFFD for three bytes): a length check alone passes it.
    ['a truncated four-byte sequence', Buffer.from([0xf0, 0x9f, 0x98])],
    ['a valid U+FFFD, indistinguishable from a lossy decode', Buffer.from(`ok${String.fromCodePoint(0xfffd)}`)],
  ] as const)('refuses %s as a text that is not portable, before checkout', ([, bytes]) => {
    installGit({ links: [link('plugins/foo/a', OID_A, bytes)] });
    expectRefusedBeforeCheckout(clone(), { code: COPY_LINK_ESCAPES_SOURCE_CODE, message: expect.stringContaining('plugins/foo/a is a symbolic link whose text is not portable') });
  });

  it('judges a planted header inside a valid UTF-8 blob as that blob\'s own text', () => {
    const a = `x\n${OID_B} blob 2\nok`;
    installGit({ links: [link('plugins/foo/a', OID_A, a), link('plugins/foo/b', OID_B, UNC)] });
    expectRefusedBeforeCheckout(clone(), { code: COPY_LINK_ESCAPES_SOURCE_CODE, message: expect.stringContaining('plugins/foo/b is a symbolic link whose target leads through a network path') });
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
    expectRefusedBeforeCheckout(clone(), failed(/plugins\/foo\/a: its bytes do not end where its header says/));
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
    expectRefusedBeforeCheckout(clone(), failed(/plugins\/foo\/a: its header .* is not/));
  });
});

describe('cloneGitSource judges committed link texts by the shared untrusted-link rule', () => {
  it.for([
    ['a NUL', `ok${NUL}${UNC}`],
    ['a component ending in a space', '.. /.. /x'],
    ['a component ending in a dot', 'docs./x'],
  ] as const)('refuses a text holding %s as not portable, on every host', ([, text]) => {
    installGit({ links: [link('plugins/foo/a', OID_A, text)] });
    expectRefusedBeforeCheckout(clone(), { code: COPY_LINK_ESCAPES_SOURCE_CODE, message: expect.stringContaining('plugins/foo/a is a symbolic link whose text is not portable') });
  });

  it('refuses a text that climbs above the repository by either flavor\'s separators', () => {
    installGit({ links: [link('plugins/foo/a', OID_A, String.raw`..\../..\x`)] });
    expectRefusedBeforeCheckout(clone(), { code: COPY_LINK_ESCAPES_SOURCE_CODE, message: expect.stringContaining('plugins/foo/a is a symbolic link to a path outside the clone') });
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

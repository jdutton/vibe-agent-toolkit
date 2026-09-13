/* eslint-disable security/detect-non-literal-fs-filename */
/**
 * Unit tests for resolveLocalHref — shared href → filesystem path resolution.
 *
 * This utility is used by both the audit (agent-skills) and validate (resources)
 * code paths to consistently handle anchor stripping, URL-decoding, and the
 * RFC 3986 §4.2 absolute-path reference (leading `/`) case.
 */

import nodeFs, { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  createSymlink,
  fillRealpaths,
  FsLookupCache,
  mkdirSyncReal,
  normalizedTmpdir,
  normalizePath,
  realpathFrom,
  safePath,
  symlinkCapability,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  canonicalizeSync,
  isWithinProject,
  isWithinProjectFrom,
  resolveLocalHref,
} from '../src/utils.js';

// Symlink creation requires admin/Developer Mode on Windows. The realpath escape
// logic these guard is platform-agnostic (the symmetry case is really a macOS
// /tmp → /private/tmp concern) and covered on POSIX CI, so probe the real
// capability rather than gate on raw platform — this also lets the fixture run
// on an elevated/Developer-Mode Windows host instead of skipping it outright.
const symlinkCap = symlinkCapability();

const SOURCE = '/project/docs/README.md';
const SOURCE_DIR = '/project/docs';
const GUIDE_MD = './guide.md';
const FOO_MD_HREF = '/docs/foo.md';
const FOO_MD_REL = 'docs/foo.md';
const EXPECTED_RESOLVED = 'expected resolved';

describe('resolveLocalHref', () => {
  it('resolves a simple relative path to kind=resolved', () => {
    const result = resolveLocalHref(GUIDE_MD, SOURCE);
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(result.resolvedPath).toBe(safePath.resolve(SOURCE_DIR, GUIDE_MD));
    expect(result.anchor).toBeUndefined();
  });

  it('strips anchor and returns it separately', () => {
    const result = resolveLocalHref('./guide.md#section', SOURCE);
    if (result.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(result.resolvedPath).toBe(safePath.resolve(SOURCE_DIR, GUIDE_MD));
    expect(result.anchor).toBe('section');
  });

  it('returns kind=anchor_only for anchor-only links', () => {
    const result = resolveLocalHref('#heading', SOURCE);
    expect(result.kind).toBe('anchor_only');
  });

  it('decodes %20 as space', () => {
    const result = resolveLocalHref('My%20Folder/doc.md', SOURCE);
    if (result.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(result.resolvedPath).toBe(safePath.resolve(SOURCE_DIR, 'My Folder/doc.md'));
    expect(result.anchor).toBeUndefined();
  });

  it('decodes %26 as ampersand', () => {
    const result = resolveLocalHref('Fraud%20%26%20Investigations/CLAUDE.md', SOURCE);
    if (result.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(result.resolvedPath).toBe(
      safePath.resolve(SOURCE_DIR, 'Fraud & Investigations/CLAUDE.md'),
    );
    expect(result.anchor).toBeUndefined();
  });

  it('decodes percent-encoding AND strips anchor', () => {
    const result = resolveLocalHref('My%20Folder/doc.md#intro', SOURCE);
    if (result.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(result.resolvedPath).toBe(safePath.resolve(SOURCE_DIR, 'My Folder/doc.md'));
    expect(result.anchor).toBe('intro');
  });

  it('falls back to raw href on invalid percent-encoding', () => {
    const result = resolveLocalHref('bad%ZZencoding.md', SOURCE);
    if (result.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(result.resolvedPath).toBe(safePath.resolve(SOURCE_DIR, 'bad%ZZencoding.md'));
    expect(result.anchor).toBeUndefined();
  });
});

/** Resolve `href` from `SOURCE` and return the path, failing loudly on any other kind. */
function resolvedPathOf(href: string, projectRoot?: string): string {
  const result = resolveLocalHref(href, SOURCE, projectRoot);
  if (result.kind !== 'resolved') throw new Error(`${EXPECTED_RESOLVED} for ${href}, got ${result.kind}`);
  return result.resolvedPath;
}

/** Whether a resolved path still carries a `.` or `..` segment — the shape `judgePath` refuses. */
function carriesDotSegment(resolvedPath: string): boolean {
  return toForwardSlash(resolvedPath).split('/').some((segment) => segment === '.' || segment === '..');
}

describe('resolveLocalHref separator normalisation', () => {
  // 🪤 On POSIX `path.resolve('/project/docs', '..\\outside\\secret.md')` is ONE
  // filename — the backslashes are ordinary bytes — so the result was
  // `/project/docs/..\outside\secret.md`, which `safePath` then forward-slashed
  // AFTER resolution into `/project/docs/../outside/secret.md`: a "resolved"
  // path still carrying `..`. `spellingWalkRoot` picked `/project/docs`,
  // `judgePath` saw a leading `..` and threw its programming-error guard, and
  // `vat resources validate` exited 2 with the developer's absolute path in the
  // message. The same href with forward slashes validated at exit 0.
  //
  // A backslash IS a path separator in an href: the WHATWG URL parser treats
  // `\` as `/` for every special scheme, so a browser following
  // `[x](..\outside\secret.md)` fetches `../outside/secret.md`. Resolving it as
  // a filename character disagreed with every renderer.
  const SEPARATOR_ROWS: ReadonlyArray<readonly [backslash: string, forward: string]> = [
    [String.raw`..\outside\secret.md`, '../outside/secret.md'],
    [String.raw`.\sub\target.md`, './sub/target.md'],
    [String.raw`sub\..\..\outside\x.md`, 'sub/../../outside/x.md'],
    [String.raw`./sub\target.md`, './sub/target.md'],
    [String.raw`..\..\..\..\..\..\etc\hosts`, '../../../../../../etc/hosts'],
  ];

  it.each(SEPARATOR_ROWS)('resolves %j exactly as %j', (backslash, forward) => {
    expect(resolvedPathOf(backslash)).toBe(resolvedPathOf(forward));
  });

  it.each(SEPARATOR_ROWS)('leaves no dot segment in the resolution of %j', (backslash) => {
    // The invariant the judge's guard depends on. A result with `..` still in
    // it is not resolved, whatever `path.resolve` was asked.
    expect(carriesDotSegment(resolvedPathOf(backslash))).toBe(false);
  });

  it('keeps a percent-encoded backslash in its segment — an encoded separator is a byte in the name', () => {
    // `%5C` would decode to `\` AFTER the separator pass, and `safePath.resolve`
    // forward-slashes the RESULT — which is exactly how the `..` survived the
    // first time. It gets the same treatment as `%2F` (below): kept as written,
    // so it names a file that does not exist rather than a boundary.
    const resolved = resolvedPathOf('..%5Coutside%5Csecret.md');
    expect(resolved).toBe(safePath.resolve(SOURCE_DIR, '..%5Coutside%5Csecret.md'));
    expect(carriesDotSegment(resolved)).toBe(false);
  });

  it('leaves the anchor alone — a backslash after `#` is fragment text, not a separator', () => {
    const result = resolveLocalHref(String.raw`.\sub\target.md#sec\tion`, SOURCE);
    if (result.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(result.resolvedPath).toBe(safePath.resolve(SOURCE_DIR, 'sub/target.md'));
    expect(result.anchor).toBe(String.raw`sec\tion`);
  });

  it('reads a backslash-rooted href as the RFC 3986 §4.2 absolute-path form', () => {
    const result = resolveLocalHref(String.raw`\docs\foo.md`, SOURCE, '/project');
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.resolvedPath).toBe(safePath.resolve('/project', 'docs/foo.md'));
  });
});

describe('resolveLocalHref decodes per path segment', () => {
  // RFC 3986 §2.2: a percent-encoded reserved character is NOT equivalent to the
  // character itself. `%2F` inside a segment is a `/` in the file's NAME, which
  // no filesystem can hold — GitHub and every browser 404 `./sub%2Ftarget.md`
  // while VAT, decoding the whole href before splitting it, validated it green
  // against `sub/target.md`. The only link this ever affected was a broken one
  // reported as fine.
  it('keeps an encoded `/` inside its segment instead of splitting on it', () => {
    expect(resolvedPathOf('./sub%2Ftarget.md')).toBe(safePath.resolve(SOURCE_DIR, 'sub%2Ftarget.md'));
    expect(resolvedPathOf('./sub%2ftarget.md')).toBe(safePath.resolve(SOURCE_DIR, 'sub%2ftarget.md'));
    expect(resolvedPathOf('./a%2Fb/c.md')).toBe(safePath.resolve(SOURCE_DIR, 'a%2Fb/c.md'));
  });

  it('still decodes an unreserved octet inside a segment', () => {
    expect(resolvedPathOf('./sub/tar%20get.md')).toBe(safePath.resolve(SOURCE_DIR, 'sub/tar get.md'));
  });

  it('still decodes `%2e%2e` to a dot segment, as RFC 3986 §2.3 requires', () => {
    // `.` is unreserved, so `%2e%2e` IS `..` — the escape gate downstream
    // (OKF's `leavesRootAsWritten`) sees the same resolved path either way.
    expect(resolvedPathOf('./sub/%2e%2e/%2e%2e/outside/secret.md')).toBe(resolvedPathOf('../outside/secret.md'));
    expect(resolvedPathOf('%2E%2E/x.md')).toBe(resolvedPathOf('../x.md'));
  });

  it('falls back per segment on malformed encoding, decoding the segments that are well-formed', () => {
    expect(resolvedPathOf('My%20Folder/bad%ZZ.md')).toBe(safePath.resolve(SOURCE_DIR, 'My Folder/bad%ZZ.md'));
  });

  it('does not read a leading `%2F` as the root-anchored form', () => {
    // Root-anchoring is decided on the href AS WRITTEN. An encoded `/` at the
    // front is a segment that begins with a literal `/` — unresolvable, and
    // reported by the lanes as missing rather than silently re-rooted.
    const result = resolveLocalHref('%2FREADME.md', SOURCE, '/project');
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.resolvedPath).toBe(safePath.resolve(SOURCE_DIR, '%2FREADME.md'));
  });
});

describe('resolveLocalHref leading-/ behavior', () => {
  const PROJECT_ROOT = '/proj';
  const SOURCE_IN_PROJECT = '/proj/docs/sub/page.md';

  it('leading-/ resolves to projectRoot', () => {
    const r = resolveLocalHref(FOO_MD_HREF, SOURCE_IN_PROJECT, PROJECT_ROOT);
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') return;
    expect(r.resolvedPath).toBe(safePath.resolve(PROJECT_ROOT, FOO_MD_REL));
  });

  it('no leading-/ keeps source-dir-relative behavior even with projectRoot supplied', () => {
    const r = resolveLocalHref('../foo.md', SOURCE_IN_PROJECT, PROJECT_ROOT);
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') return;
    // /proj/docs/sub/../foo.md → /proj/docs/foo.md
    expect(r.resolvedPath).toBe(safePath.resolve('/proj/docs', 'foo.md'));
  });

  it('leading-/ with no projectRoot returns absolute_no_root', () => {
    const r = resolveLocalHref(FOO_MD_HREF, SOURCE_IN_PROJECT);
    expect(r.kind).toBe('absolute_no_root');
    if (r.kind !== 'absolute_no_root') return;
    expect(r.href).toBe(FOO_MD_HREF);
    expect(r.anchor).toBeUndefined();
  });

  it('preserves anchor across leading-/ resolution', () => {
    const r = resolveLocalHref(`${FOO_MD_HREF}#section`, SOURCE_IN_PROJECT, PROJECT_ROOT);
    if (r.kind !== 'resolved') throw new Error(EXPECTED_RESOLVED);
    expect(r.anchor).toBe('section');
  });

  it('preserves anchor on absolute_no_root', () => {
    const r = resolveLocalHref(`${FOO_MD_HREF}#section`, SOURCE_IN_PROJECT);
    expect(r.kind).toBe('absolute_no_root');
    if (r.kind !== 'absolute_no_root') return;
    expect(r.anchor).toBe('section');
  });

  describe('escape detection (real-filesystem)', () => {
    let projectRoot: string;
    let parentDir: string;
    let sourceFile: string;

    beforeAll(() => {
      // Real tmpdir + real escape target so isWithinProject's realpath check
      // can fire.  Layout:
      //   <parent>/escape.md          (escape target)
      //   <parent>/proj/docs/sub/page.md  (source)
      //   <parent>/proj/badlink       (symlink → external escape.md)
      parentDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-leading-slash-'));
      parentDir = normalizePath(parentDir);
      projectRoot = safePath.join(parentDir, 'proj');
      mkdirSyncReal(safePath.join(projectRoot, 'docs', 'sub'), { recursive: true });
      sourceFile = safePath.join(projectRoot, 'docs', 'sub', 'page.md');
      writeFileSync(sourceFile, '# Source\n');

      const escapeFile = safePath.join(parentDir, 'escape.md');
      writeFileSync(escapeFile, '# Escape\n');

      // Symlink escape: <projectRoot>/badlink → ../escape.md. Creating a symlink
      // needs elevation/Developer Mode on Windows (EPERM otherwise), so only the
      // symlink-specific test below depends on it; guard creation here.
      if (symlinkCap) {
        createSymlink(symlinkCap, escapeFile, safePath.join(projectRoot, 'badlink'));
      }
    });

    afterAll(() => {
      rmSync(parentDir, { recursive: true, force: true });
    });

    it('leading-/ with .. traversal that escapes projectRoot returns absolute_escapes_root', () => {
      const r = resolveLocalHref('/../escape.md', sourceFile, projectRoot);
      expect(r.kind).toBe('absolute_escapes_root');
      if (r.kind !== 'absolute_escapes_root') return;
      expect(r.href).toBe('/../escape.md');
    });

    it.skipIf(!symlinkCap)('symlinked escape returns absolute_escapes_root', () => {
      const r = resolveLocalHref('/badlink', sourceFile, projectRoot);
      expect(r.kind).toBe('absolute_escapes_root');
    });

    it('leading-/ that stays within projectRoot resolves cleanly', () => {
      const r = resolveLocalHref('/docs/sub/page.md', sourceFile, projectRoot);
      expect(r.kind).toBe('resolved');
      if (r.kind !== 'resolved') return;
      expect(r.resolvedPath).toBe(sourceFile);
    });
  });
});

/**
 * Row B of the containment truth table: a project root reached **through a
 * symlink** — macOS `/tmp → /private/tmp`, a bind mount, a worktree under a
 * symlinked path.
 *
 * ⚠️ **The `escape detection (real-filesystem)` fixture above cannot see this
 * class of bug, which is exactly why one shipped.** It takes its base from
 * `normalizedTmpdir()`, which is already realpath'd, so for a path under it the
 * lexical resolve and the canonical form are the SAME string and any assertion
 * that tries to tell them apart is vacuous. Here `link-root → real-root` makes
 * the two spellings differ, and every test below states that difference —
 * {@link expectFixtureDiscriminates} — before trusting its own verdict.
 */
describe('symlinked project root (real-filesystem)', () => {
  let baseDir = '';
  let realRoot = '';
  let canonicalRealRoot = '';
  let linkRoot = '';
  let outsideDir = '';
  let sourceViaLink = '';
  let sourceViaReal = '';

  const GONE_HREF = '/docs/gone.md';
  const RESOLVED = 'resolved';
  const ESCAPES = 'absolute_escapes_root';

  beforeAll(() => {
    //   <base>/real-root/docs/sub/page.md      source; the only real file inside
    //   <base>/link-root        → real-root    every question is asked THROUGH this
    //   <base>/outside/data.md                 escape target, a sibling of the root
    //   <base>/real-root/outlink → ../outside  directory link that leaves the root
    baseDir = normalizePath(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-symlink-root-')));
    realRoot = safePath.join(baseDir, 'real-root');
    linkRoot = safePath.join(baseDir, 'link-root');
    outsideDir = safePath.join(baseDir, 'outside');
    mkdirSyncReal(safePath.join(realRoot, 'docs', 'sub'), { recursive: true });
    mkdirSyncReal(outsideDir, { recursive: true });
    sourceViaReal = safePath.join(realRoot, 'docs', 'sub', 'page.md');
    writeFileSync(sourceViaReal, '# Source\n');
    writeFileSync(safePath.join(outsideDir, 'data.md'), '# Outside\n');

    if (symlinkCap) {
      createSymlink(symlinkCap, realRoot, linkRoot, 'dir');
      createSymlink(symlinkCap, outsideDir, safePath.join(realRoot, 'outlink'), 'dir');
    }

    // `realpathSync`, never `normalizePath()`/`realpathSync.native`: Node ships
    // two realpaths that report different CASING on a case-insensitive
    // filesystem, and `canonicalizeSync` takes this one. An oracle built on the
    // other route would be asserting against a different function.
    // eslint-disable-next-line local/no-fs-realpathSync -- must take the exact route the code under test takes; see canonicalizeSync's docblock
    canonicalRealRoot = toForwardSlash(realpathSync(realRoot));
    sourceViaLink = safePath.join(linkRoot, 'docs', 'sub', 'page.md');
  });

  afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  /**
   * A fixture that cannot make the two candidate answers differ cannot fail, and
   * a green over it means nothing. This states the discrimination as an
   * assertion: the LEXICAL spelling of a path asked through `link-root` does not
   * sit under the canonical root, so only an answer in the canonical namespace
   * can be judged contained.
   */
  const expectFixtureDiscriminates = (pathViaLink: string): void => {
    expect(safePath.resolve(pathViaLink).startsWith(canonicalRealRoot + '/')).toBe(false);
  };

  it.skipIf(!symlinkCap)('row A: an EXISTING file under a symlinked root resolves', () => {
    expectFixtureDiscriminates(sourceViaLink);
    const r = resolveLocalHref('/docs/sub/page.md', sourceViaLink, linkRoot);
    expect(r.kind).toBe(RESOLVED);
  });

  it.skipIf(!symlinkCap)(
    'row B: a MISSING file under a symlinked root resolves, it does not escape',
    () => {
      // The shipped bug: `canonicalizeSync` answered the missing path lexically,
      // in `link-root`'s namespace, while the root gained `real-root`'s — so a
      // merely BROKEN link was reported as leaving the project.
      expectFixtureDiscriminates(safePath.join(linkRoot, 'docs', 'gone.md'));
      const r = resolveLocalHref(GONE_HREF, sourceViaLink, linkRoot);
      expect(r.kind).toBe(RESOLVED);
    },
  );

  it('row C: a MISSING file under a plain root resolves', () => {
    const r = resolveLocalHref(GONE_HREF, sourceViaReal, realRoot);
    expect(r.kind).toBe(RESOLVED);
  });

  it.skipIf(!symlinkCap)(
    'row D: an EXISTING file behind a directory link that leaves the root still escapes',
    () => {
      const r = resolveLocalHref('/outlink/data.md', sourceViaLink, linkRoot);
      expect(r.kind).toBe(ESCAPES);
    },
  );

  it.skipIf(!symlinkCap)(
    'row D: a MISSING file behind a directory link that leaves the root still escapes',
    () => {
      // The walk widens nothing: the deepest existing ancestor of this path IS
      // the escaping link, so the missing remainder lands outside the root too.
      const r = resolveLocalHref('/outlink/gone.md', sourceViaLink, linkRoot);
      expect(r.kind).toBe(ESCAPES);
    },
  );

  it.skipIf(!symlinkCap)(
    'walks through several missing levels to reach the ancestor that exists',
    () => {
      expectFixtureDiscriminates(safePath.join(linkRoot, 'docs', 'nope', 'deeper', 'gone.md'));
      const r = resolveLocalHref('/docs/nope/deeper/gone.md', sourceViaLink, linkRoot);
      expect(r.kind).toBe(RESOLVED);
    },
  );

  it.skipIf(!symlinkCap)(
    'isWithinProject and isWithinProjectFrom answer identically for a missing file',
    async () => {
      // THE invariant the sync walk exists to protect. `isWithinProject` asks the
      // filesystem live; `isWithinProjectFrom` reads the column filled by
      // `FsLookupCache.realpath`. The two are documented as exactly equivalent,
      // and with only one of the two forms walking ancestors they disagree here.
      const missing = safePath.join(linkRoot, 'docs', 'gone.md');
      const escaping = safePath.join(linkRoot, 'outlink', 'gone.md');
      expectFixtureDiscriminates(missing);

      const table = await fillRealpaths([missing, escaping, linkRoot], new FsLookupCache());

      expect(isWithinProject(missing, linkRoot)).toBe(isWithinProjectFrom(table, missing, linkRoot));
      expect(isWithinProject(missing, linkRoot)).toBe(true);
      expect(isWithinProject(escaping, linkRoot)).toBe(
        isWithinProjectFrom(table, escaping, linkRoot),
      );
      expect(isWithinProject(escaping, linkRoot)).toBe(false);
    },
  );

  it.skipIf(!symlinkCap)(
    'canonicalizeSync answers byte for byte what FsLookupCache.realpath answers',
    async () => {
      // The stated contract, asserted on the STRING rather than on a verdict.
      // The two-sided equality alone would pass if both forms drifted the same
      // way, so each expected value is also pinned outright.
      const missing = safePath.join(linkRoot, 'docs', 'gone.md');
      const deepMissing = safePath.join(linkRoot, 'docs', 'nope', 'deeper', 'gone.md');
      const cache = new FsLookupCache();
      const table = await fillRealpaths([missing, deepMissing, sourceViaLink, linkRoot], cache);

      expect(canonicalizeSync(missing)).toBe(realpathFrom(table, missing));
      expect(canonicalizeSync(deepMissing)).toBe(realpathFrom(table, deepMissing));
      expect(canonicalizeSync(sourceViaLink)).toBe(realpathFrom(table, sourceViaLink));
      expect(canonicalizeSync(linkRoot)).toBe(realpathFrom(table, linkRoot));

      expect(canonicalizeSync(missing)).toBe(safePath.join(canonicalRealRoot, 'docs', 'gone.md'));
      expect(canonicalizeSync(deepMissing)).toBe(
        safePath.join(canonicalRealRoot, 'docs', 'nope', 'deeper', 'gone.md'),
      );
      expect(canonicalizeSync(linkRoot)).toBe(canonicalRealRoot);
    },
  );

  it('terminates at the filesystem root when nothing on the path canonicalizes', () => {
    // The fixpoint guard is UNREACHABLE through a real posix filesystem —
    // `realpathSync('/')` always succeeds, so the walk stops there for lack of a
    // failure, not for lack of a parent. It is reachable on Windows (a
    // nonexistent or disconnected drive root). Forcing every canonicalization to
    // fail reproduces that shape anywhere: without the guard the walk asks
    // `dirname` for a parent it already has and spins forever, so this test dies
    // by TIMEOUT rather than by assertion. Reaching the expect at all is half of
    // what it asserts.
    const spy = vi.spyOn(nodeFs, 'realpathSync').mockImplementation((() => {
      // Not ENOENT: EACCES and ELOOP land in the same catch, and the walk is
      // deliberately errno-blind.
      throw new Error('EACCES: permission denied');
    }) as unknown as typeof nodeFs.realpathSync);
    try {
      const fsRoot = toForwardSlash(path.parse(safePath.resolve(baseDir)).root);
      const missing = safePath.join(fsRoot, 'a', 'b', 'c.md');

      // Nothing resolved, so the walk composes back to the lexical form — the
      // only answer available, and the right one when no component exists.
      expect(canonicalizeSync(missing)).toBe(missing);
      expect(spy.mock.calls.length).toBeGreaterThan(1);
    } finally {
      spy.mockRestore();
    }
  });
});

/* eslint-disable security/detect-non-literal-fs-filename -- tempDir paths are test-generated, safe in test context */
/**
 * Every component of a link path is judged — not just its basename.
 *
 * ## 🪤 The defect these pin
 *
 * `validateResolvedFile` classified `basename(resolvedPath)` against a listing
 * of `dirname(resolvedPath)`. That hands every DIRECTORY component of a link
 * straight back to the host filesystem's own folding: `readdir('<root>/Docs')`
 * succeeds on macOS/APFS when the directory is really `docs`, the basename then
 * matches byte for byte, and VAT reported nothing — for a link that 404s on
 * every case-sensitive filesystem the repository is cloned onto. The Unicode
 * half was silent the same way, and that one 404s on Linux.
 *
 * Worse than incomplete, the *remedy* was wrong: with two components misspelled
 * the suggestion said `Use "three.md" instead of "Three.md"`, and an author who
 * followed it verbatim still had a broken link.
 *
 * ## What is asserted, and why it is a property rather than an example
 *
 * The nested suite misspells EACH component of a three-deep path in turn and
 * demands the same quality of answer for every one. A fix that special-cased
 * "the parent directory" would satisfy an example and fail the property.
 *
 * ## ⛔ The cost assertion is COUNTED WORK, never wall-clock
 *
 * The judge this replaced ran up to three linear scans over the parent listing
 * per link, folding every entry to NFC and lower case on the way, so the cost
 * was O(links × entries-in-that-directory). A millisecond budget would make the
 * machine a silent second requirement and pass or fail on load; what is asserted
 * instead is how many times a directory ENTRY is examined, counted by handing
 * `readdir` back a Proxy that tallies index reads.
 */
import nodeFsPromises from 'node:fs/promises';

import {
  FsLookupCache,
  issueLocation,
  safePath,
  setupAsyncTempDirSuite,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyLink } from '../src/link-classify.js';
import { fragmentIndex, resolveLinkEntry, validateLink } from '../src/link-validator.js';

import { REFUSAL_ERRNOS, withReaddirRefused } from './helpers/refused-listing.js';
import { createLink, writeFileIn } from './test-helpers.js';

const suite = setupAsyncTempDirSuite('link-path-components');

beforeAll(suite.beforeAll);
afterAll(suite.afterAll);
beforeEach(suite.beforeEach);

/** Plant `files` (relative path → body) under this test's temp dir. */
function plant(files: Record<string, string>): string {
  const root = suite.getTempDir();
  for (const [relative, body] of Object.entries(files)) writeFileIn(root, relative, body);
  return root;
}

/** Judge one href written in `<projectRoot>/<source>`. */
async function judgeIn(
  projectRoot: string,
  source: string,
  href: string,
  fsCache = new FsLookupCache(),
) {
  return await validateLink(
    createLink('local_file', href),
    safePath.join(projectRoot, source),
    fragmentIndex(),
    { fsCache, projectRoot, skipGitIgnoreCheck: true },
  );
}

/**
 * A verdict minus the href it was about, for comparing two spellings of one
 * link: the href is the ONE field entitled to differ.
 */
function stripHref(issue: Awaited<ReturnType<typeof validateLink>>): Record<string, unknown> | null {
  if (issue === null) return null;
  return Object.fromEntries(Object.entries(issue).filter(([field]) => field !== 'link'));
}

/** Judge one href written in `<root>/a.md`. */
async function judge(root: string, href: string, fsCache = new FsLookupCache()) {
  return await judgeIn(root, 'a.md', href, fsCache);
}

/**
 * Whether a POSIX mode actually binds this process. Windows does not enforce
 * mode bits, and **root ignores them** — a root process lists a `--x` directory
 * happily, which would make the assertion below pass against the very bug it
 * exists to catch.
 */
const PERMISSIONS_ENFORCED = process.platform !== 'win32' && process.getuid?.() !== 0;

/**
 * Owner `--x`: traversable, so the file below still opens — and NOT listable.
 * Only the owner bits are set, which is all this process's own access depends
 * on, and the restore is the matching owner-only `rwx`.
 */
const MODE_TRAVERSE_ONLY = 0o100;
const MODE_RWX_OWNER = 0o700;

/**
 * Run `body` with `dir` traversable but unlistable, restoring the mode after.
 *
 * ⚠️ The `finally` is not tidiness: a directory left `--x` cannot be removed,
 * so the temp-dir teardown fails and poisons every later test.
 */
async function withUnlistableDirectory<T>(dir: string, body: () => Promise<T>): Promise<T> {
  await nodeFsPromises.chmod(dir, MODE_TRAVERSE_ONLY);
  try {
    return await body();
  } finally {
    await nodeFsPromises.chmod(dir, MODE_RWX_OWNER);
  }
}

const DEEP_TARGET = 'one/two/three.md';
const DEEP_BUNDLE = { 'a.md': '# a\n', [DEEP_TARGET]: '# three\n' };

/**
 * A tree whose target sits two levels below `docs/open` — the directory the
 * refusal suites make unlistable while leaving it traversable.
 *
 * Deliberately deeper than `docs/open` itself: the refusal has to be met at an
 * ANCESTOR of the target rather than at its own parent, which is the case the
 * basename-only judge never listed and so never met.
 */
const REFUSAL_HREF = './docs/open/inner/target.md';
const REFUSAL_TREE = { 'a.md': '# a\n', 'docs/open/inner/target.md': '# t\n' };

/** The components of a bundle-relative path, which is always forward-slashed. */
function componentsOf(relativePath: string): string[] {
  return toForwardSlash(relativePath).split('/');
}

/** The trailing components of `relativePath`, from `index` down. */
function suffixFrom(relativePath: string, index: number): string {
  return componentsOf(relativePath).slice(index).join('/');
}

/** The same path with component `index` upper-cased. */
function miscased(index: number): string {
  const parts = componentsOf(DEEP_TARGET);
  const part = parts[index] ?? '';
  parts[index] = part.charAt(0).toUpperCase() + part.slice(1);
  return parts.join('/');
}

/**
 * Count how many times a directory ENTRY is read out of a listing.
 *
 * `readdir` is handed back a Proxy over its own answer, so the tally covers
 * both shapes: the linear `find()` scans the old judge ran per link, and the
 * single indexing pass that replaced them.
 */
async function entryReadsFor(root: string, links: number): Promise<number> {
  let reads = 0;
  const original = nodeFsPromises.readdir.bind(nodeFsPromises);
  const spy = vi.spyOn(nodeFsPromises, 'readdir').mockImplementation((async (
    directory: string,
  ) => {
    const names = (await original(directory)) as unknown as string[];
    return new Proxy(names, {
      get(target, property, receiver) {
        if (typeof property === 'string' && Number.isInteger(Number(property))) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
  }) as unknown as typeof nodeFsPromises.readdir);

  try {
    const fsCache = new FsLookupCache();
    for (let n = 0; n < links; n += 1) {
      await judge(root, `./missing-${n}.md`, fsCache);
    }
  } finally {
    spy.mockRestore();
  }
  return reads;
}

describe('a link path is judged component by component', () => {
  describe('a misspelled component is reported wherever it sits', () => {
    // 🪤 The property, not the example: on a case-insensitive host the OLD
    // judge answered these three cases three different ways — silence,
    // silence, and a correct finding — because only the last component was
    // ever compared against a listing.
    for (const index of [0, 1, 2]) {
      it(`reports component ${index} of "${DEEP_TARGET}" when only that one is miscased`, async () => {
        const root = plant(DEEP_BUNDLE);
        const asked = miscased(index);

        const issue = await judge(root, `./${asked}`);

        expect(issue).not.toBeNull();
        // The correction names every component from the first wrong one down,
        // so following it verbatim produces a link that opens.
        const askedSuffix = suffixFrom(asked, index);
        const actualSuffix = suffixFrom(DEEP_TARGET, index);
        expect(issue?.suggestion).toBe(`Use "${actualSuffix}" instead of "${askedSuffix}"`);
      });
    }

    it('names BOTH wrong components when a directory and the file are miscased', async () => {
      // 🪤 The basename-only remedy said `Use "three.md" instead of "Three.md"`.
      // An author who wrote that down still had a link that 404s on Linux.
      const root = plant(DEEP_BUNDLE);

      const issue = await judge(root, './one/Two/Three.md');

      expect(issue?.suggestion).toBe('Use "two/three.md" instead of "Two/Three.md"');
    });

    it('reports a directory component that differs only in Unicode normalization', async () => {
      // NFC on disk, NFD in the link. macOS reconciles the two at the syscall
      // level; a byte-exact filesystem does not, so this 404s on Linux.
      const root = plant({ 'a.md': '# a\n', 'café/guide.md': '# g\n' });

      const issue = await judge(root, './café/guide.md');

      expect(issue?.code).toBe('LINK_NORMALIZATION_MISMATCH');
    });

    it('still reports a target nothing matches as plainly missing', async () => {
      // 🪤 The negative control for the CORRECTION, not for the finding. A path
      // nothing matched carries an empty corrected spelling, and a correction
      // derived from that quotes a file with no name — which turns every
      // genuinely missing target into a case-mismatch report and hands the
      // deferred-artifact gate a materialized file that does not exist.
      const root = plant(DEEP_BUNDLE);

      const issue = await judge(root, './one/two/nowhere.md');

      expect(issue?.code).toBe('LINK_BROKEN_FILE');
      expect(issue?.message).toContain('File not found');
      // No correction to offer means no `suggestion` at all — not an empty one.
      expect(issue).not.toHaveProperty('suggestion');
    });

    /**
     * 🪤 The regression judging every component introduced: every ancestor
     * below the walk root must now be LISTABLE, where the basename-only judge
     * only ever listed `dirname(target)`. A `0111` directory is traversable —
     * `open()` on the file below it succeeds, so the link genuinely works —
     * but `readdir` is refused. That refusal was recoded as absence and
     * reported as `LINK_BROKEN_FILE`: both the verdict and the diagnosis wrong,
     * about a link that opens.
     *
     * 🪤 **And then the first repair went one step too far and made it
     * silent.** `validateLocalFileLink` read `unverifiable` and returned `null`
     * — no issue, no counter, nothing in the report — which suppressed FOUR
     * checks for that link (existence, deferred artifact, gitignore leak, and
     * the anchor) with nothing said. A refusal is not a pass. It is its own
     * condition, and the only honest report of it names the link that went
     * unchecked.
     */
    it.skipIf(!PERMISSIONS_ENFORCED)(
      'reports a link whose ancestor directory cannot be listed as UNREAD, not as broken',
      async () => {
        const root = plant(REFUSAL_TREE);

        const issue = await withUnlistableDirectory(
          safePath.join(root, 'docs', 'open'),
          async () => await judge(root, REFUSAL_HREF),
        );

        expect(issue?.code).toBe('LINK_TARGET_UNREADABLE');
        expect(issue?.link).toBe(REFUSAL_HREF);
      },
    );

    describe('a refused listing is reported, whatever refused it', () => {
      /**
       * `chmod` reaches exactly one of the four errnos that mean "refused", and
       * only where POSIX modes bind. The other three are reachable in ordinary
       * operation — `EMFILE`/`ENFILE` are descriptor exhaustion under
       * concurrency, `ELOOP` a committed symlink cycle — and a fix narrowed to
       * `EACCES` would leave them reported as broken links.
       */
      it.each(REFUSAL_ERRNOS)('reports %s rather than a missing file', async (code) => {
        const root = plant(REFUSAL_TREE);

        const issue = await withReaddirRefused(
          safePath.join(root, 'docs', 'open'),
          code,
          async () => await judge(root, REFUSAL_HREF),
        );

        expect(issue?.code).toBe('LINK_TARGET_UNREADABLE');
        // The whole complaint about the old behaviour: it said the file was not
        // there, about a file that opens.
        expect(issue?.message).not.toContain('File not found');
        // Project-relative, like every other link issue in this lane — an
        // absolute path here is the developer's $HOME in a CI log.
        expect(issue?.message).not.toContain(root);
        // 🪤 "A directory on that path" is a remedy a reader cannot aim: this
        // path has three of them. The message names WHICH one refused, still
        // project-relative, and WHY.
        expect(issue?.message).toContain('"docs/open"');
        expect(issue?.message).toContain(code);
      });

      it('tells the reader to re-run only when the refusal was a transient shortage', async () => {
        // The two refusals earn different remedies and always did: a mode bit
        // is the author's to fix, a descriptor shortage is a moment that a
        // second run walks straight past. One message for both spends the
        // reader's attention on whichever half does not apply.
        const root = plant(REFUSAL_TREE);
        const refused = safePath.join(root, 'docs', 'open');
        const judgeRefusedWith = async (code: string) =>
          await withReaddirRefused(refused, code, async () => await judge(root, REFUSAL_HREF));

        const transient = await judgeRefusedWith('EMFILE');
        const stable = await judgeRefusedWith('EACCES');

        expect(transient?.message).toContain('re-run');
        expect(stable?.message).not.toContain('re-run');
      });

      it('does not call EAGAIN descriptor exhaustion', async () => {
        // 🚨 The transient set is `EMFILE`, `ENFILE` and `EAGAIN`, and the
        // remedy was worded "is descriptor exhaustion" for all of it — a
        // second copy, in prose, of a fact `fs-utils` was made the single owner
        // of, and wrong for the third member. The clause now comes from the
        // owner of the errno list, so it cannot drift from it.
        const root = plant(REFUSAL_TREE);

        const issue = await withReaddirRefused(
          safePath.join(root, 'docs', 'open'),
          'EAGAIN',
          async () => await judge(root, REFUSAL_HREF),
        );

        expect(issue?.message).toContain('re-run');
        expect(issue?.message).toContain('EAGAIN');
        expect(issue?.message).not.toContain('descriptor exhaustion');
      });

      it('spells the target against the SAME root as `location` when no project root is given', async () => {
        // 🚨 `location` is relativised to `process.cwd()` when the caller
        // supplies no root (`locationRoot`), while the message printed the
        // absolute target and directory — one issue, two roots, and the
        // absolute one is the developer's $HOME in a CI log. The message also
        // carried `suggestion: ''`, copied from a sibling.
        const root = plant(REFUSAL_TREE);

        const issue = await withReaddirRefused(
          safePath.join(root, 'docs', 'open'),
          'EACCES',
          async () => await validateLink(
            createLink('local_file', REFUSAL_HREF),
            safePath.join(root, 'a.md'),
            fragmentIndex(),
            { fsCache: new FsLookupCache(), skipGitIgnoreCheck: true },
          ),
        );

        expect(issue?.code).toBe('LINK_TARGET_UNREADABLE');
        // The exact spellings, not `not.toContain(root)`: a cwd-relative path
        // to a temp dir still CONTAINS the absolute one as a substring after
        // its `../` prefix, so absence of the root proves nothing here.
        const cwd = process.cwd();
        expect(issue?.message).toContain(
          `Link target ${issueLocation(safePath.join(root, 'docs', 'open', 'inner', 'target.md'), cwd)} was NOT checked`,
        );
        expect(issue?.message).toContain(`"${issueLocation(safePath.join(root, 'docs', 'open'), cwd)}"`);
        expect(issue?.location).toBe(issueLocation(safePath.join(root, 'a.md'), cwd));
        expect(issue).not.toHaveProperty('suggestion');
      });

      it('still reports a genuinely missing target as broken', async () => {
        // The negative control for the DISTINCTION. A fix that reported every
        // absence as a refusal would satisfy the four rows above while
        // destroying the finding that matters most.
        const root = plant(REFUSAL_TREE);

        const issue = await judge(root, './docs/open/inner/nowhere.md');

        expect(issue?.code).toBe('LINK_BROKEN_FILE');
      });

      it('keeps a case mismatch it found ABOVE the refusing directory instead of calling the spelling unverified', async () => {
        // 🪤 `docs/Open/inner/target.md` against a disk `docs/open` that then
        // refuses to list: component 1 WAS judged, and found wrong — that link
        // 404s on Linux whatever the mode bit below says. The message used to
        // say "Its existence, spelling and anchor are all unverified", which is
        // false of the component VAT verified; the verdict had thrown it away.
        const root = plant(REFUSAL_TREE);

        const issue = await withReaddirRefused(
          safePath.join(root, 'docs', 'open'),
          'EACCES',
          async () => await judge(root, './docs/Open/inner/target.md'),
        );

        expect(issue?.code).toBe('LINK_TARGET_UNREADABLE');
        expect(issue?.message).toContain('"docs/Open" is spelled "docs/open" on disk');
        expect(issue?.message).toContain('case');
        expect(issue?.message).not.toContain('spelling and anchor are all unverified');
        // The half that IS still unverified is still said to be.
        expect(issue?.message).toContain('existence and anchor');
      });
    });

    it('says nothing when every component matches byte for byte', async () => {
      // The negative control. A judge that reported every nested link would
      // satisfy every assertion above.
      const root = plant(DEEP_BUNDLE);

      expect(await judge(root, `./${DEEP_TARGET}`)).toBeNull();
    });
  });

  describe('a Windows-authored href is judged exactly as its forward-slash spelling', () => {
    /**
     * 🪤 `[x](..\outside\secret.md)` CRASHED `vat resources validate` — exit 2,
     * every other finding discarded, the walk root's absolute path (the
     * developer's `$HOME` in a CI log) in the message — while
     * `[x](../outside/secret.md)` validated at exit 0. On POSIX `path.resolve`
     * took the backslashes as filename bytes, `safePath` forward-slashed the
     * RESULT, and a "resolved" path reached `judgePath` still carrying `..`,
     * which is the one shape that function refuses as a programming error.
     *
     * The property is EQUALITY between the two spellings, verdict for verdict:
     * a fix that merely stopped the throw (a `catch`, a `null`) would leave the
     * two spellings disagreeing about the same link.
     */
    const PROJECT = 'proj';
    const SOURCE = 'docs/a.md';
    const TREE = {
      'proj/docs/a.md': '# a\n',
      'proj/docs/sub/target.md': '# t\n',
      'proj/other/b.md': '# b\n',
      // Above the project root and present on disk: what `..` reaches.
      'outside/secret.md': '# s\n',
    };

    const BACKSLASH_ROWS: ReadonlyArray<readonly [backslash: string, forward: string]> = [
      // A `..` that lands OUTSIDE the project, target present — the crash row.
      [String.raw`..\..\outside\secret.md`, '../../outside/secret.md'],
      // The same escape, target missing.
      [String.raw`..\..\outside\nope.md`, '../../outside/nope.md'],
      // `.\` prefix, present and missing.
      [String.raw`.\sub\target.md`, './sub/target.md'],
      [String.raw`.\sub\nope.md`, './sub/nope.md'],
      // Mixed separators in one href.
      [String.raw`./sub\target.md`, './sub/target.md'],
      // Descends, then climbs out of the project.
      [String.raw`sub\..\..\..\outside\secret.md`, 'sub/../../../outside/secret.md'],
      // Climbs and re-enters the project — inside, so fully judged.
      [String.raw`..\other\b.md`, '../other/b.md'],
      // A miscased directory component reached through backslashes: the
      // component walk must run, and its correction must match.
      [String.raw`.\Sub\target.md`, './Sub/target.md'],
    ];

    it.each(BACKSLASH_ROWS)('gives %j the verdict of %j', async (backslash, forward) => {
      const temp = plant(TREE);
      const projectRoot = safePath.join(temp, PROJECT);

      // `judgeIn` rather than `judge`: the source sits one level below the
      // project root, so `..` from it stays inside and `..\..` leaves.
      const viaBackslash = await judgeIn(projectRoot, SOURCE, backslash);
      const viaForward = await judgeIn(projectRoot, SOURCE, forward);

      // `link` is the href as written and legitimately differs; every other
      // field — code, message, suggestion, location — must not.
      expect(stripHref(viaBackslash)).toEqual(stripHref(viaForward));
    });

    it('reports a missing backslash target with a forward-slashed, project-relative path', async () => {
      // Not a restatement of the equality row: this pins WHAT the shared
      // verdict says, so the pair cannot agree on a wrong message.
      const temp = plant(TREE);

      const issue = await judgeIn(safePath.join(temp, PROJECT), SOURCE, String.raw`.\sub\nope.md`);

      expect(issue?.code).toBe('LINK_BROKEN_FILE');
      expect(issue?.message).toBe('File not found: docs/sub/nope.md');
    });

    it('does not reinterpret a backslash inside a URL — a URL never reaches the resolver', async () => {
      // The two are told apart upstream, by `classifyLink`: any href with a
      // scheme (`:`) or a `//` prefix is `external`/`unknown`, and
      // `resolveLinkEntry` resolves only `local_file`/`local_directory`.
      const href = String.raw`https://x/a\b`;
      expect(classifyLink(href)).toBe('external');

      const entry = resolveLinkEntry({ link: createLink('external', href), sourceFilePath: '/p/a.md' }, '/p');

      expect(entry).not.toHaveProperty('resolution');
      expect(entry.link.href).toBe(href);
    });
  });

  describe('a percent-encoded separator is a character in the name, not a boundary', () => {
    it('reports `./sub%2Ftarget.md` as missing even though `sub/target.md` exists', async () => {
      // RFC 3986 §2.2. GitHub and every browser 404 this href; VAT decoded the
      // whole href before splitting it and validated it green.
      const root = plant({ 'a.md': '# a\n', 'sub/target.md': '# t\n' });

      const issue = await judge(root, './sub%2Ftarget.md');

      expect(issue?.code).toBe('LINK_BROKEN_FILE');
      expect(issue?.message).toBe('File not found: sub%2Ftarget.md');
    });

    it('still resolves an encoded space inside a segment', async () => {
      // The negative control: per-segment decoding must not stop decoding.
      const root = plant({ 'a.md': '# a\n', 'sub/tar get.md': '# t\n' });

      expect(await judge(root, './sub/tar%20get.md')).toBeNull();
    });
  });

  describe('the cost of judging is bounded by the directory, not by the links', () => {
    it('examines a directory the same number of times whatever the link count', async () => {
      const files: Record<string, string> = { 'a.md': '# a\n' };
      for (let n = 0; n < 200; n += 1) files[`neighbour-${n}.md`] = '# n\n';
      const root = plant(files);

      const few = await entryReadsFor(root, 5);
      const many = await entryReadsFor(root, 200);

      // Every link misses, which is the path the old shape paid THREE folded
      // scans for. The number must be a property of the directory alone.
      expect(many).toBe(few);
    });
  });
});

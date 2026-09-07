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
  safePath,
  setupAsyncTempDirSuite,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { fragmentIndex, validateLink } from '../src/link-validator.js';

import { createLink } from './test-helpers.js';

const suite = setupAsyncTempDirSuite('link-path-components');

beforeAll(suite.beforeAll);
afterAll(suite.afterAll);
beforeEach(suite.beforeEach);

/** Plant `files` (relative path → body) under this test's temp dir. */
async function plant(files: Record<string, string>): Promise<string> {
  const root = suite.getTempDir();
  for (const [relative, body] of Object.entries(files)) {
    const absolute = safePath.join(root, relative);
    await nodeFsPromises.mkdir(safePath.join(absolute, '..'), { recursive: true });
    await nodeFsPromises.writeFile(absolute, body);
  }
  return root;
}

/** Judge one href written in `<root>/a.md`. */
async function judge(root: string, href: string, fsCache = new FsLookupCache()) {
  return await validateLink(
    createLink('local_file', href),
    safePath.join(root, 'a.md'),
    fragmentIndex(),
    { fsCache, projectRoot: root, skipGitIgnoreCheck: true },
  );
}

const DEEP_TARGET = 'one/two/three.md';
const DEEP_BUNDLE = { 'a.md': '# a\n', [DEEP_TARGET]: '# three\n' };

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
        const root = await plant(DEEP_BUNDLE);
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
      const root = await plant(DEEP_BUNDLE);

      const issue = await judge(root, './one/Two/Three.md');

      expect(issue?.suggestion).toBe('Use "two/three.md" instead of "Two/Three.md"');
    });

    it('reports a directory component that differs only in Unicode normalization', async () => {
      // NFC on disk, NFD in the link. macOS reconciles the two at the syscall
      // level; a byte-exact filesystem does not, so this 404s on Linux.
      const root = await plant({ 'a.md': '# a\n', 'café/guide.md': '# g\n' });

      const issue = await judge(root, './café/guide.md');

      expect(issue?.code).toBe('LINK_NORMALIZATION_MISMATCH');
    });

    it('still reports a target nothing matches as plainly missing', async () => {
      // 🪤 The negative control for the CORRECTION, not for the finding. A path
      // nothing matched carries an empty corrected spelling, and a correction
      // derived from that quotes a file with no name — which turns every
      // genuinely missing target into a case-mismatch report and hands the
      // deferred-artifact gate a materialized file that does not exist.
      const root = await plant(DEEP_BUNDLE);

      const issue = await judge(root, './one/two/nowhere.md');

      expect(issue?.code).toBe('LINK_BROKEN_FILE');
      expect(issue?.message).toContain('File not found');
      expect(issue?.suggestion).toBe('');
    });

    it('says nothing when every component matches byte for byte', async () => {
      // The negative control. A judge that reported every nested link would
      // satisfy every assertion above.
      const root = await plant(DEEP_BUNDLE);

      expect(await judge(root, `./${DEEP_TARGET}`)).toBeNull();
    });
  });

  describe('the cost of judging is bounded by the directory, not by the links', () => {
    it('examines a directory the same number of times whatever the link count', async () => {
      const files: Record<string, string> = { 'a.md': '# a\n' };
      for (let n = 0; n < 200; n += 1) files[`neighbour-${n}.md`] = '# n\n';
      const root = await plant(files);

      const few = await entryReadsFor(root, 5);
      const many = await entryReadsFor(root, 200);

      // Every link misses, which is the path the old shape paid THREE folded
      // scans for. The number must be a property of the directory alone.
      expect(many).toBe(few);
    });
  });
});

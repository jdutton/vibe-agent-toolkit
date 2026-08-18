/**
 * The `populationSource` seam on `ResourceRegistry.crawl`.
 *
 * The seam splits one question into two that used to be welded together:
 * **which paths exist** (the source's job) and **which of them this project's
 * globs admit** (still the registry's). These tests pin that split, because a
 * lane that filtered in its source as well would put the project's include and
 * exclude patterns in two places — and the whole reason a second crawler is
 * reviewable is that a difference in its output is a difference in the
 * POPULATION, not in what the globs were taken to mean.
 *
 * The source is a stub rather than the real projection on purpose: the real one
 * enumerates the filesystem, and a test that crawls to decide what the crawl
 * returns cannot show a path being offered and refused.
 *
 * The second suite pins the ROOT-IDENTITY GUARD: a source declares the ONE root
 * it can answer for, and a crawl that offers it a different one is declined back
 * onto the walk rather than served a population of the wrong tree.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

import { compareCodeUnits, normalizedTmpdir, safePath, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResourcePopulationSource } from '../src/projection/resource-population.js';
import { ResourceRegistry } from '../src/resource-registry.js';

/** The fixture members every test in this file writes. */
const FIXTURE_NAMES = ['a.md', 'b.md', 'notes.txt'] as const;

/** Write this file's fixture members into `root`. */
async function writeFixture(root: string): Promise<void> {
  await Promise.all(FIXTURE_NAMES.map((name) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture beneath a mkdtemp root
    writeFile(safePath.join(root, name), `# ${name}\n`, 'utf-8')));
}

/**
 * A source bound to `boundRoot` that offers `names` under whatever root it is
 * ASKED for, and records every root it was asked about.
 *
 * The bound root is a parameter rather than derived from anything: every guard
 * test below is exactly a case where the bound root and the offered root differ,
 * and a helper that derived one from the other could not express one.
 */
function boundSource(
  boundRoot: string,
  names: readonly string[] = FIXTURE_NAMES,
): { source: ResourcePopulationSource; offeredRoots: string[] } {
  const offeredRoots: string[] = [];
  return {
    offeredRoots,
    source: {
      root: boundRoot,
      enumerate: (root: string) => {
        offeredRoots.push(root);
        return Promise.resolve(names.map((name) => safePath.join(root, name)));
      },
    },
  };
}

/**
 * Ways of writing the SAME directory that a resolved comparison must treat as
 * one root. Case is not here: whether two casings are one directory is a property
 * of the filesystem, so it gets its own probed test below.
 */
const EQUIVALENT_ROOT_SPELLINGS: ReadonlyArray<[string, (root: string) => string]> = [
  ['spelled with a trailing separator', (root) => `${root}/`],
  ['spelled with a non-normalised traversal', (root) => `${root}/out/..`],
];

/** Registry members as root-relative paths, in a stable order. */
function memberPaths(root: string, resources: readonly { filePath: string }[]): string[] {
  return resources.map((r) => safePath.relative(root, r.filePath)).sort(compareCodeUnits);
}

/**
 * Whether the volume the temp trees live on folds case, PROBED rather than
 * inferred from `process.platform`: a case-sensitive volume can be mounted on
 * macOS and a case-insensitive one on Linux, and the guard's case behaviour is a
 * statement about the filesystem, not about the OS.
 *
 * @returns True when one existing directory answers to two spellings
 */
function tempVolumeFoldsCase(): boolean {
  const probe = normalizedTmpdir();
  /* eslint-disable security/detect-non-literal-fs-filename -- the OS temp directory, not caller input */
  return existsSync(probe.toUpperCase()) && existsSync(probe.toLowerCase());
  /* eslint-enable security/detect-non-literal-fs-filename */
}

describe('ResourceRegistry.crawl with a populationSource', () => {
  const suite = setupAsyncTempDirSuite('registry-population-source');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    await writeFixture(tempDir);
  });

  it('takes its paths from the source instead of walking the tree', async () => {
    const registry = new ResourceRegistry({ baseDir: tempDir });

    const resources = await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
      // A path the source never offers, proving the walk did not run: `b.md` is
      // on disk and a real crawl would find it.
      populationSource: boundSource(tempDir, ['a.md']).source,
    });

    expect(resources.map((r) => safePath.relative(tempDir, r.filePath))).toEqual(['a.md']);
  });

  it('still applies include patterns to what the source offered', async () => {
    const registry = new ResourceRegistry({ baseDir: tempDir });

    const resources = await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
      populationSource: boundSource(tempDir).source,
    });

    // `notes.txt` was offered and refused HERE. A source that pre-filtered would
    // make this assertion pass without the registry doing anything.
    expect(memberPaths(tempDir, resources)).toEqual(['a.md', 'b.md']);
  });

  it('still applies exclude patterns to what the source offered', async () => {
    const registry = new ResourceRegistry({ baseDir: tempDir });

    const resources = await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
      exclude: ['**/b.md'],
      populationSource: boundSource(tempDir).source,
    });

    expect(resources.map((r) => safePath.relative(tempDir, r.filePath))).toEqual(['a.md']);
  });
});

describe('ResourceRegistry.crawl root-identity guard', () => {
  const suite = setupAsyncTempDirSuite('registry-population-root-guard');
  let tempDir: string;
  let warnings: string[];

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    await writeFixture(tempDir);
    warnings = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a source whose bound root IS the crawl base', async () => {
    // The POSITIVE CONTROL for every "was not asked" assertion below: same
    // fixture, same helper, the only difference being which root the source
    // declares. Without it a guard that declined unconditionally would satisfy
    // every one of them.
    const registry = new ResourceRegistry({ baseDir: tempDir });
    const { source, offeredRoots } = boundSource(tempDir, ['a.md']);

    const resources = await registry.crawl({ baseDir: tempDir, include: ['**/*.md'], populationSource: source });

    expect(offeredRoots).toEqual([safePath.resolve(tempDir)]);
    expect(memberPaths(tempDir, resources)).toEqual(['a.md']);
    expect(warnings).toEqual([]);
  });

  it('declines a source bound to a DIFFERENT root and walks instead', async () => {
    const registry = new ResourceRegistry({ baseDir: tempDir });
    const foreignRoot = safePath.join(tempDir, 'out', 'demo');
    // The source offers exactly one member, so "the source answered" and "the
    // walk answered" are distinguishable from the result alone: the walk finds
    // both markdown files on disk.
    const { source, offeredRoots } = boundSource(foreignRoot, ['a.md']);

    const resources = await registry.crawl({ baseDir: tempDir, include: ['**/*.md'], populationSource: source });

    expect(offeredRoots).toEqual([]);
    expect(memberPaths(tempDir, resources)).toEqual(['a.md', 'b.md']);
  });

  it('names BOTH roots when it declines, so the decline is not silent', async () => {
    const registry = new ResourceRegistry({ baseDir: tempDir });
    const foreignRoot = safePath.join(tempDir, 'out', 'demo');

    await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
      populationSource: boundSource(foreignRoot).source,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(safePath.resolve(foreignRoot));
    expect(warnings[0]).toContain(safePath.resolve(tempDir));
  });

  it('warns once per (bound, offered) pair rather than once per crawl', async () => {
    const foreignRoot = safePath.join(tempDir, 'out', 'demo');
    const { source } = boundSource(foreignRoot);

    for (let attempt = 0; attempt < 3; attempt++) {
      await new ResourceRegistry({ baseDir: tempDir })
        .crawl({ baseDir: tempDir, include: ['**/*.md'], populationSource: source });
    }

    expect(warnings).toHaveLength(1);
  });

  // Spellings that all name the crawl base. A raw string comparison declines
  // every one of them, and the symptom would be a lane that quietly stopped
  // helping rather than anything that looks like a bug — which is why these are
  // pinned per spelling rather than left to the resolved-equality happy path.
  it.each(EQUIVALENT_ROOT_SPELLINGS)('accepts a bound root %s', async (_label, spell) => {
    const registry = new ResourceRegistry({ baseDir: tempDir });
    const { source, offeredRoots } = boundSource(spell(tempDir), ['a.md']);

    await registry.crawl({ baseDir: tempDir, include: ['**/*.md'], populationSource: source });

    expect(offeredRoots).toEqual([safePath.resolve(tempDir)]);
    expect(warnings).toEqual([]);
  });

  it.skipIf(!tempVolumeFoldsCase())(
    'accepts a differently-cased bound root where the filesystem folds case',
    async () => {
      const registry = new ResourceRegistry({ baseDir: tempDir });
      const { source, offeredRoots } = boundSource(tempDir.toUpperCase(), ['a.md']);

      await registry.crawl({ baseDir: tempDir, include: ['**/*.md'], populationSource: source });

      // One directory, two spellings — the filesystem itself says so, so the
      // guard must not read them as two roots.
      expect(offeredRoots).toEqual([safePath.resolve(tempDir)]);
      expect(warnings).toEqual([]);
    },
  );
});

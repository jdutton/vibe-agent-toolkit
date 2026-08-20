/**
 * The crawl-timing seam, driven by REAL work.
 *
 * The model is `parse-timing.test.ts`: import the real producers, run them, and
 * assert the call counts they charged. Nothing here builds a `CrawlTimingEntry`
 * by hand and asserts it came back — a test that does that passes with every
 * instrumentation call deleted, which is exactly the defect this seam exists to
 * fix. The `onContributorTiming` option it replaces shipped with no observer
 * anywhere in the repository, so both of its brackets could have been removed
 * with nothing failing.
 *
 * So the fixture is a real corpus on disk, walked by the real
 * `FilesystemExtentContributor` and the real `ClosureExtentContributor` through
 * the real merge driver, and every assertion names a call count that one specific
 * bracket produced.
 *
 * ## Both arms, or the suite proves nothing
 *
 * That discipline still let a defect through, because every assertion here named
 * a PROJECTION bracket. The incumbent arm was charged for its traversal and for
 * nothing else — not the enumeration, not the per-file admission, not the link
 * resolution the walk then follows — and the suite stayed green while the dump
 * invited a 1.7 ms figure to be held against a ~1,016 ms one. A real corpus is
 * not sufficient; the corpus has to be driven down BOTH routes. `ResourceRegistry`
 * is therefore built here directly, as the six production sites build it.
 */

import { readdir, readFile } from 'node:fs/promises';

import {
  __readCrawlTimingSnapshot,
  __setCrawlTimingForTest,
  __writeCrawlTimingDumpForTest,
  CRAWL_BLOB_POPULATE_ID,
  CRAWL_CLOSURE_CONTRIBUTE_ID,
  CRAWL_CLOSURE_RESOLVE_ID,
  CRAWL_PASS_INSIDE,
  CRAWL_REGISTRY_ADD_RESOURCE_ID,
  CRAWL_REGISTRY_ENUMERATE_ID,
  CRAWL_REGISTRY_ID_PREFIX,
  CRAWL_REGISTRY_RESOLVE_LINKS_ID,
  CRAWL_STRATA,
  type CrawlTimingDump,
  type CrawlTimingEntry,
  safePath,
} from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ContributorRegistry,
  type ContributorStratum,
  type ExtentContribution,
  type ExtentContributor,
} from '../src/projection/contributor.js';
import { ClosureExtentContributor } from '../src/projection/contributors/closure-extent.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { DISCARD_BLOB_POPULATION, populate, type ContributorTiming } from '../src/projection/merge.js';
import { ResourceRegistry } from '../src/resource-registry.js';
import type { JsonValue } from '../src/schemas/projection-shared.js';

import { setupSubdirTestSuite, useCorpusSuite } from './test-helpers.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * The pass every driver-placed `base` row carries — `merge.ts`'s
 * `BASE_STRATUM_PASS`, restated here because it is package-internal.
 *
 * Written as a literal rather than imported on purpose: this is the wire value a
 * reader in another package classifies on, so the test should fail if the driver
 * changes it, not follow it.
 */
const BASE_STRATUM_PASS_IN_DUMP = 1;

const SKILL_KIND = 'skill';
const EXTENT_NAME = 'foo-bundle';
const NESTED_DIR = 'skills/foo';
const ROOT_DOC = 'skills/foo/SKILL.md';
const DOC_B = 'skills/foo/b.md';
const DOC_C = 'skills/foo/c.md';

/** The id the merge driver charges the closure contributor under. */
const CLOSURE_DRIVER_ID = `closure:${EXTENT_NAME}`;

/** The id the merge driver charges the filesystem contributor under. */
const FILESYSTEM_DRIVER_ID = 'builtin:filesystem';

/**
 * A chain `SKILL.md → b.md → c.md`, so more than one reference is resolved.
 *
 * A one-edge fixture could not tell the per-reference resolve bracket apart from
 * the per-invocation contribute bracket: both would read `calls: 1` per pass.
 */
const CORPUS: readonly { path: string; content: string }[] = [
  { path: ROOT_DOC, content: '---\nname: foo\n---\n\n# Foo\n\nSee [b](./b.md).\n' },
  { path: DOC_B, content: '# B\n\nOn to [c](./c.md).\n' },
  { path: DOC_C, content: '# C\n\nNothing links out of here.\n' },
];

/** How many references the closure resolves per pass over {@link CORPUS}. */
const REFERENCES_PER_PASS = 2;

const suite = setupSubdirTestSuite('crawl-timing-');

/** The declaration the closure contributor runs under. */
function closureDeclaration(): Record<string, JsonValue> {
  return {
    kind: SKILL_KIND,
    closureFrom: ROOT_DOC,
    follow: ['markdown-link'],
    maxDepth: 'full',
  };
}

/** The two shipped contributors this fixture measures, in registration order. */
function registryWithClosure(): ContributorRegistry {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());
  registry.register(new ClosureExtentContributor(EXTENT_NAME, SKILL_KIND));
  return registry;
}

/**
 * Run the whole driver over the fixture corpus.
 *
 * @param onTiming - Optional in-process observer, to pin that both destinations fire
 */
async function runPopulation(onTiming?: (timing: ContributorTiming) => void): Promise<void> {
  await populate({
    root: suite.tempDir,
    registry: registryWithClosure(),
    parameters: { [CLOSURE_DRIVER_ID]: closureDeclaration() },
    ...(onTiming === undefined ? {} : { onContributorTiming: onTiming }),
    onBlobPopulation: DISCARD_BLOB_POPULATION,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * One row out of a snapshot, failing loudly when it is absent.
 *
 * A missing row is the failure this suite exists to catch — the seam charging
 * nothing — so it throws with the rows that ARE present rather than returning
 * `undefined` into a lenient assertion.
 *
 * @param dump - The snapshot to read
 * @param contributorId - The row's id
 * @param pass - The row's pass
 * @returns The row
 */
function entryOf(dump: CrawlTimingDump, contributorId: string, pass: number): CrawlTimingEntry {
  const found = dump.entries.find(
    (entry) => entry.contributorId === contributorId && entry.pass === pass,
  );
  if (found === undefined) {
    const present = dump.entries.map((entry) => `${entry.contributorId}@${String(entry.pass)}`);
    throw new Error(
      `no row for '${contributorId}' at pass ${String(pass)}; the dump carries: ` +
        `${present.join(', ') || '(nothing)'}`,
    );
  }
  return found;
}

/** Every row's identity, for order and round-trip assertions. */
function keysOf(dump: CrawlTimingDump): string[] {
  return dump.entries.map(
    (entry) => `${entry.stratum}|${entry.contributorId}@${String(entry.pass)}`,
  );
}

/** Read a written dump back off disk. */
async function readDump(path: string): Promise<CrawlTimingDump> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path returned by the seam under test
  return JSON.parse(await readFile(path, 'utf-8')) as CrawlTimingDump;
}

/** Where this suite points the seam. Beneath the fixture root, removed with it. */
function dumpDir(): string {
  return safePath.join(suite.tempDir, '.crawl-dumps');
}

/** Every row the `ResourceRegistry` brackets produced, whatever stratum it landed in. */
function registryRows(dump: CrawlTimingDump): CrawlTimingEntry[] {
  return dump.entries.filter((entry) => entry.contributorId.startsWith(CRAWL_REGISTRY_ID_PREFIX));
}

/**
 * A `base` contributor that builds a whole `ResourceRegistry` inside its own
 * `contribute` — the hypothetical this suite's double-charge pin exists for.
 *
 * Nothing shipped does this: no file under `src/projection/` so much as imports
 * `ResourceRegistry` (the base contributors reach for `crawlDirectory`,
 * `GitTracker` and `node:fs` directly, and `blob-population.ts` parses through
 * `parseKeyed`). It is written here rather than waited for because the accounting
 * rule it pins has to hold on the FIRST commit that routes a contributor through
 * the registry, not on the one after somebody notices the arms disagreed.
 */
class RegistryBuildingContributor implements ExtentContributor {
  readonly id = 'test:registry-building';
  readonly kind = 'test-kind';
  readonly stratum: ContributorStratum = 'base';

  readonly readsBlobs = false;

  /**
   * Build a registry over the fixture and contribute nothing.
   *
   * @returns An empty contribution — the rows are irrelevant; the registry build is the point
   */
  async contribute(): Promise<ExtentContribution> {
    const registry = await ResourceRegistry.fromCrawl({ baseDir: suite.tempDir });
    registry.resolveLinks();
    return { contexts: [], resources: [], realizations: [], memberships: [], tags: [], conditions: [] };
  }
}

// ---------------------------------------------------------------------------

describe('crawl timing seam', () => {
  useCorpusSuite(suite, [NESTED_DIR], CORPUS);

  afterEach(() => {
    // Always leave the seam off: it is module-level state shared by every test in
    // this file, and an enabled seam would leak into the next one.
    __setCrawlTimingForTest(null);
  });

  describe('disabled', () => {
    it('accumulates nothing and writes nothing when the seam is off', async () => {
      // `vitest.setup.js` deletes every VAT_* variable before any module loads,
      // so the module-load gate is off — this is the shipped default state.
      await runPopulation();

      expect(__readCrawlTimingSnapshot().entries).toEqual([]);
      expect(__writeCrawlTimingDumpForTest()).toBeNull();
    });
  });

  describe('enabled', () => {
    beforeEach(() => {
      __setCrawlTimingForTest(dumpDir());
    });

    it('charges the merge driver one row per contributor per pass', async () => {
      await runPopulation();
      const snapshot = __readCrawlTimingSnapshot();

      // A base contributor runs exactly once, at pass 1.
      expect(entryOf(snapshot, FILESYSTEM_DRIVER_ID, 1).calls).toBe(1);
      expect(entryOf(snapshot, FILESYSTEM_DRIVER_ID, 1).stratum).toBe('base');
      // The closure stratum needs a confirming pass, so its contributor runs
      // twice — as two SEPARATE rows, which is the whole reason `pass` is part of
      // the key. A seam that pooled them could not tell "cheap but run in every
      // pass" from "expensive once", which is the distinction the option's own
      // documentation promises.
      expect(entryOf(snapshot, CLOSURE_DRIVER_ID, 1).calls).toBe(1);
      expect(entryOf(snapshot, CLOSURE_DRIVER_ID, 2).calls).toBe(1);
      expect(entryOf(snapshot, CLOSURE_DRIVER_ID, 1).stratum).toBe('closure');
    });

    it('places a driver row as NESTED when a registry enumeration contains the whole population', async () => {
      // The projection lane's shape, in miniature: `ResourceRegistry.crawl`
      // brackets its enumeration and, when handed a population source, that
      // enumeration IS a `populate()`. Before `withOuterBracket` the base rows
      // came back at pass 1 — additive — and were summed alongside the
      // `enumerate` row that already contained them, which on this repository
      // read as `enumerate` 7,508.4 ms against `base` 7,501.4 ms and printed as
      // an even split between two crawlers.
      const registry = new ResourceRegistry();
      await registry.crawl({
        baseDir: suite.tempDir,
        populationSource: {
          // Bound to the very root the crawl is about, or the registry's root
          // guard would decline it and this dump would hold no `base` rows at all.
          root: suite.tempDir,
          enumerate: async (root: string) => {
            await populate({
              root,
              registry: registryWithClosure(),
              parameters: { [CLOSURE_DRIVER_ID]: closureDeclaration() },
              onBlobPopulation: DISCARD_BLOB_POPULATION,
            });
            return [];
          },
        },
      });

      const snapshot = __readCrawlTimingSnapshot();
      // Pass 0, not pass 1: the row says "I am inside something this dump
      // already timed", which is what keeps it out of the total.
      expect(entryOf(snapshot, FILESYSTEM_DRIVER_ID, CRAWL_PASS_INSIDE).stratum).toBe('base');
      expect(
        snapshot.entries.filter((entry) => entry.contributorId === FILESYSTEM_DRIVER_ID && entry.pass >= 1),
      ).toStrictEqual([]);
      // The containing row is still additive and still comparable to the
      // walker's own `enumerate` — the fix moves the inner rows, never this one.
      expect(entryOf(snapshot, CRAWL_REGISTRY_ENUMERATE_ID, CRAWL_PASS_INSIDE).calls).toBe(1);
    });

    it('charges a driver row as additive when nothing contains it', async () => {
      // The negative control for the test above, and the reason it is not
      // vacuous: the same contributor, the same seam, no containing bracket —
      // pass 1, additive. Without this, a `withOuterBracket` that leaked and
      // demoted every row in the process would still pass.
      await runPopulation();

      expect(entryOf(__readCrawlTimingSnapshot(), FILESYSTEM_DRIVER_ID, 1).stratum).toBe('base');
    });

    it('charges the closure contributor from inside its own body, once per invocation', async () => {
      await runPopulation();

      const inside = entryOf(
        __readCrawlTimingSnapshot(),
        CRAWL_CLOSURE_CONTRIBUTE_ID,
        CRAWL_PASS_INSIDE,
      );
      // Two fixpoint passes, aggregated into ONE row because a contributor's own
      // body does not know which pass it is in — which is what `pass: 0` says.
      expect(inside.calls).toBe(2);
      expect(inside.stratum).toBe('closure');
    });

    it('charges the closure walk once per reference it resolves', async () => {
      await runPopulation();

      // Two edges (SKILL.md → b.md → c.md) × two fixpoint passes.
      expect(
        entryOf(__readCrawlTimingSnapshot(), CRAWL_CLOSURE_RESOLVE_ID, CRAWL_PASS_INSIDE).calls,
      ).toBe(REFERENCES_PER_PASS * 2);
    });

    // -----------------------------------------------------------------------
    // The incumbent arm. These are the tests the seam shipped without, and
    // their absence is why the two arms were bracketed at different depths for
    // three commits: every existing assertion above names a PROJECTION bracket,
    // so the walker arm could charge nothing but its own traversal and the whole
    // suite stayed green.
    // -----------------------------------------------------------------------

    it('charges the incumbent for building the registry its walk consumes, not only for the walk', async () => {
      const registry = await ResourceRegistry.fromCrawl({ baseDir: suite.tempDir });
      registry.resolveLinks();
      const snapshot = __readCrawlTimingSnapshot();

      // The counts are derived from the fixture, not restated as literals: a
      // bracket in the wrong place (once per crawl instead of once per file, say)
      // produces a number that still looks plausible, and only a count tied to the
      // corpus can tell the two apart.
      expect(registry.size()).toBe(CORPUS.length);
      expect(entryOf(snapshot, CRAWL_REGISTRY_ENUMERATE_ID, CRAWL_PASS_INSIDE).calls).toBe(1);
      expect(entryOf(snapshot, CRAWL_REGISTRY_ADD_RESOURCE_ID, CRAWL_PASS_INSIDE).calls).toBe(
        CORPUS.length,
      );
      expect(entryOf(snapshot, CRAWL_REGISTRY_RESOLVE_LINKS_ID, CRAWL_PASS_INSIDE).calls).toBe(1);

      // All three in the WALKER's stratum. A preparation row filed anywhere else
      // would leave the arm-versus-arm line reading traversal against
      // preparation-plus-traversal, which is the defect these tests exist for.
      expect(registryRows(snapshot).map((entry) => entry.stratum)).toEqual([
        'crawl',
        'crawl',
        'crawl',
      ]);
    });

    it('charges admission when the caller enumerated the corpus itself', async () => {
      // `crawlSkillLinkRegistry` (claude-marketplace) has this shape: it calls
      // `crawlDirectory` itself and hands the paths to `addResources`. The
      // admission bracket has to sit deep enough to catch that route too.
      const registry = new ResourceRegistry({ baseDir: suite.tempDir });
      await registry.addResources(
        CORPUS.map((file) => safePath.join(suite.tempDir, file.path)),
      );
      const snapshot = __readCrawlTimingSnapshot();

      expect(entryOf(snapshot, CRAWL_REGISTRY_ADD_RESOURCE_ID, CRAWL_PASS_INSIDE).calls).toBe(
        CORPUS.length,
      );
      // …and no enumeration row, because that caller's own `crawlDirectory` call
      // is outside the registry and therefore outside this seam. Pinned rather
      // than left implicit: it is a REAL uncharged phase on one of the six
      // registry-construction routes, and a reader adding up the walker arm on a
      // command that takes this route is under-counting it.
      expect(
        snapshot.entries.some((entry) => entry.contributorId === CRAWL_REGISTRY_ENUMERATE_ID),
      ).toBe(false);
    });

    it('charges registry work inside a base contributor to the projection arm, never to the walker arm', async () => {
      const contributors = new ContributorRegistry();
      contributors.register(new RegistryBuildingContributor());
      await populate({
        root: suite.tempDir,
        registry: contributors,
        onBlobPopulation: DISCARD_BLOB_POPULATION,
      });
      const snapshot = __readCrawlTimingSnapshot();

      // The driver's own row still measures the whole invocation, registry build
      // included — that is the projection arm's figure and it is unchanged.
      expect(entryOf(snapshot, 'test:registry-building', 1).stratum).toBe('base');

      // The inner rows follow the arm that invoked them. Filing them under
      // `crawl` would move a whole registry build onto the INCUMBENT's total on a
      // run the incumbent took no part in — an over-count on one arm in exchange
      // for the under-count on the other, and just as wrong.
      const inner = registryRows(snapshot);
      expect(inner.length).toBeGreaterThan(0);
      expect(inner.every((entry) => entry.stratum === 'base')).toBe(true);
      expect(inner.every((entry) => entry.pass === CRAWL_PASS_INSIDE)).toBe(true);
      expect(snapshot.entries.some((entry) => entry.stratum === 'crawl')).toBe(false);
    });

    it('charges the projection arm for its blob stage, additively', async () => {
      await runPopulation();
      const snapshot = __readCrawlTimingSnapshot();

      // `populateBlobs` reads and parses every path the base contributors keyed.
      // It is the projection's analogue of `resource-registry:add-resource`, which
      // IS charged — so leaving it uncharged biased the crawler-against-crawler
      // comparison on ONE side, unlike the `git ls-files` omission, which at least
      // cancelled. Pinned here because the row has no other guard: `closure` is 0%
      // on every shipped command, so no `vat-lab crawl run` can currently observe
      // this stage at all.
      const blob = entryOf(snapshot, CRAWL_BLOB_POPULATE_ID, BASE_STRATUM_PASS_IN_DUMP);
      expect(blob.stratum).toBe('base');
      expect(blob.calls).toBeGreaterThanOrEqual(1);
      expect(blob.elapsedMs).toBeGreaterThan(0);

      // The pass number is the assertion that matters, and it is not decoration:
      // `crawlRowRole` treats pass >= 1 as additive and pass 0 in a driver stratum
      // as a nested breakdown of a contributor row that does NOT contain this
      // stage. A bracket filed at `CRAWL_PASS_INSIDE` would leave the number in
      // the dump and out of every total — visible, uncounted, and far harder to
      // notice than an absent row.
      expect(blob.pass).not.toBe(CRAWL_PASS_INSIDE);
    });

    it('feeds the caller AND the dump from one measurement', async () => {
      const observed: ContributorTiming[] = [];
      await runPopulation((timing) => observed.push(timing));

      const fromCaller = observed.find(
        (timing) => timing.contributorId === FILESYSTEM_DRIVER_ID,
      );
      expect(fromCaller).toBeDefined();
      // The same number reaches both destinations. Two clocks would be two
      // answers to what one invocation cost.
      expect(entryOf(__readCrawlTimingSnapshot(), FILESYSTEM_DRIVER_ID, 1).elapsedMs).toBe(
        fromCaller?.elapsedMs,
      );
    });

    it('orders rows by stratum, then id, then pass, so two dumps read alike', async () => {
      await runPopulation();

      const ordinals = __readCrawlTimingSnapshot().entries.map((entry) =>
        CRAWL_STRATA.indexOf(entry.stratum),
      );
      expect(ordinals).toEqual([...ordinals].sort((left, right) => left - right));
      expect(ordinals[0]).toBe(CRAWL_STRATA.indexOf('base'));
    });

    it('round-trips the exact dump contract through JSON', async () => {
      await runPopulation();

      const path = __writeCrawlTimingDumpForTest();
      expect(path).not.toBeNull();

      const dump = await readDump(path ?? '');
      // Pinned as a literal, on purpose: this is a wire contract with a reader in
      // another package that refuses any other value
      // (`lab/src/facets/crawl/dump.ts`'s `CRAWL_DUMP_VERSION`). A bump that does
      // not move both numbers makes every dump unreadable, so it should cost a
      // failing test rather than a silent one.
      expect(dump.dumpVersion).toBe(4);
      expect(dump.pid).toBe(process.pid);
      expect(keysOf(dump)).toEqual(keysOf(__readCrawlTimingSnapshot()));
      expect(entryOf(dump, CLOSURE_DRIVER_ID, 2).calls).toBe(1);
    });

    it('reports process wall and CPU time, so the wall-timed rows can be judged', async () => {
      await runPopulation();

      const dump = await readDump(__writeCrawlTimingDumpForTest() ?? '');
      expect(dump.process.wallMs).toBeGreaterThan(0);
      expect(dump.process.cpuUserMs).toBeGreaterThan(0);
      expect(dump.process.cpuSystemMs).toBeGreaterThanOrEqual(0);
      // The process has been alive far longer than the crawl it just did, which
      // is exactly why this must never be read as a crawl duration.
      expect(dump.process.wallMs).toBeGreaterThan(
        dump.entries.reduce((sum, entry) => sum + entry.elapsedMs, 0),
      );
    });

    it('writes a dump with NO rows rather than no dump when nothing crawled', async () => {
      const dump = await readDump(__writeCrawlTimingDumpForTest() ?? '');

      // The distinction the lab reader depends on: a file with no rows means the
      // command reached no crawler, while no file at all means the build has no
      // seam. Folding the first into the second would report a real finding as an
      // instrument failure.
      expect(dump.entries).toEqual([]);
      expect(dump.dumpVersion).toBe(4);
    });

    it('does not overwrite a dump already filed under this pid', async () => {
      await runPopulation();
      const first = __writeCrawlTimingDumpForTest();
      await runPopulation();
      const second = __writeCrawlTimingDumpForTest();

      expect(second).not.toBe(first);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- directory this suite created
      await expect(readdir(dumpDir())).resolves.toHaveLength(2);
      // The first dump saw one population; the second saw two.
      expect(entryOf(await readDump(first ?? ''), FILESYSTEM_DRIVER_ID, 1).calls).toBe(1);
      expect(entryOf(await readDump(second ?? ''), FILESYSTEM_DRIVER_ID, 1).calls).toBe(2);
    });
  });
});

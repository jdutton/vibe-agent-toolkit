/* eslint-disable security/detect-non-literal-fs-filename -- tempDir paths are test-generated, safe in test context */
/**
 * The fill/judge split in link validation.
 *
 * Link validation runs in two passes: {@link resolveLinkEntries} resolves every
 * link exactly once, {@link fillLinkFacts} reads the local targets off those
 * resolutions ({@link linkTargetPaths}) and materialises both judge columns over
 * them — the parent-directory listings and the canonical paths, the latter
 * including the project root — and {@link judgeLink} decides every link
 * synchronously against those tables.
 *
 * ⭐ **The agreement test is the load-bearing one.** Both table lookups THROW on
 * a missing row, so if a fill set ever diverges from the set of paths the judge
 * asks about, link validation crashes rather than answering wrongly. `judges the
 * whole link zoo …` below is what proves the sets agree, over every link
 * variety the judge handles — and, by deep-equalling the result against the
 * one-shot `validateLink`, that the split moved no output.
 *
 * ⚠️ **The judge is STILL not free of I/O, and the tests here say so in
 * numbers.** Two columns are filled now, so `readdir`, `nodeFs.realpath` and
 * `nodeFs.realpathSync` are all pinned at zero at judgement time. What is *not*
 * filled — and not pinned here — is `git check-ignore`: `gitIgnoreSafetyIssue`
 * still spawns it per existing target when no `GitTracker` is supplied (ledger
 * entry D9).
 *
 * ⚠️ **Both realpath routes are spied, always, and BOTH live on `node:fs`.** The
 * fill canonicalizes through the *async callback* form, `nodeFs.realpath`, which
 * `FsLookupCache.realpath` promisifies per call; `resolveLocalHref` uses the
 * *sync* form, `nodeFs.realpathSync`. A zero on one route alone is a confident
 * number about the wrong syscall, so every zero-assertion here covers both.
 *
 * ⚠️ **`node:fs/promises.realpath` is the WRONG object to watch, and watching it
 * is not merely useless — it reads as proof.** The fill deliberately does not
 * take that route (it is `uv_fs_realpath`, which returns on-disk casing and so
 * disagrees with `realpathSync` on macOS and Windows; see the `FsLookupCache.realpath`
 * docblock). A spy on `fs.realpath` from `node:fs/promises` therefore attaches
 * cleanly and counts zero — indistinguishable from "the judge performs no I/O".
 * That is exactly the failure these guards exist to catch, and it is why every
 * spy carries a POSITIVE CONTROL asserted before `mockClear()`.
 *
 * All spies patch the *default export's* property — `vi.spyOn` cannot intercept
 * a NAMED ESM import of a builtin (Node snapshots named exports at import time),
 * so a spy attached to anything else silently under-counts.
 */
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';

import { FsLookupCache, safePath, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fillLinkFacts,
  fragmentIndex,
  judgeLink,
  judgeOptionsFrom,
  linkTargetPaths,
  needsRealpathColumn,
  resolveLinkEntries,
  validateLink,
  type FragmentIndex,
  type JudgeLinkOptions,
  type LinkEntry,
  type LinkFactTables,
  type ResolvedLinkEntry,
  type ValidateLinkOptions,
} from '../src/link-validator.js';
import { ResourceRegistry } from '../src/resource-registry.js';
import type { ResourceLink } from '../src/types.js';
import { resolveLocalHref } from '../src/utils.js';

import { createLink } from './test-helpers.js';

const SOURCE_ENTRY = 'source.md';
const TARGET_ENTRY = 'target.md';
const CASE_ENTRY = 'CaseFile.md';
const SUB_DIR = 'sub';
const OTHER_ENTRY = 'other.md';
const NESTED_ENTRY = 'nested.md';

/** One link variety to run through both lanes. */
interface LinkCase {
  type: ResourceLink['type'];
  href: string;
}

/**
 * Every link variety the judge handles, exercised from `docs/source.md` with a
 * `projectRoot`: resolvable relative file, root-absolute reference, anchored
 * reference, case mismatch, missing file, directory, anchor-only, external,
 * email, unknown scheme, and an absolute reference that escapes the root.
 */
const CASES_WITH_ROOT: readonly LinkCase[] = [
  { type: 'local_file', href: `./${TARGET_ENTRY}` },
  { type: 'local_file', href: `/docs/${TARGET_ENTRY}` },
  { type: 'local_file', href: `./${TARGET_ENTRY}#section-a` },
  { type: 'local_file', href: './casefile.md' },
  { type: 'local_file', href: './missing.md' },
  { type: 'local_directory', href: `./${SUB_DIR}` },
  { type: 'anchor', href: '#source' },
  { type: 'external', href: 'https://example.com/x' },
  { type: 'email', href: 'mailto:a@b.c' },
  { type: 'unknown', href: 'tel:+15555550100' },
  { type: 'local_file', href: '/../escape.md' },
];

/**
 * The no-`projectRoot` lane: an absolute-path reference that cannot resolve at
 * all (`absolute_no_root`). It needs its own group because the judge carries a
 * single `projectRoot`.
 */
const CASES_WITHOUT_ROOT: readonly LinkCase[] = [
  { type: 'local_file', href: `/docs/${TARGET_ENTRY}` },
];

/**
 * Root-absolute references only — the lane whose *resolution* costs syscalls.
 * `resolveLocalHref`'s absolute branch calls `isWithinProject`, which realpaths
 * both the candidate and the project root, so each of these costs two
 * `realpathSync` per resolution. One resolvable, one missing: the missing one
 * still resolves (and still realpaths), it just fails existence later.
 */
const ROOT_ABSOLUTE_CASES: readonly LinkCase[] = [
  { type: 'local_file', href: `/docs/${TARGET_ENTRY}` },
  { type: 'local_file', href: '/docs/missing.md' },
];

/**
 * The counted fixture: two source files whose links resolve into a *declared*
 * set of distinct targets.
 *
 * `target.md` is reached three times — relatively from two DIFFERENT source
 * files, and once more as a root-absolute href — so a fill that does not
 * de-duplicate canonicalizes it three times instead of once. The root-absolute
 * href earns its place twice over: it is the only lane whose *resolution*
 * realpaths (synchronously, outside the counted body), which is what keeps the
 * count below a statement about the fill's column rather than about resolution.
 */
const COUNTED_SOURCES: readonly { source: string; hrefs: readonly string[] }[] = [
  {
    source: SOURCE_ENTRY,
    hrefs: [`./${TARGET_ENTRY}`, `/docs/${TARGET_ENTRY}`, `./${SUB_DIR}/${NESTED_ENTRY}`],
  },
  { source: OTHER_ENTRY, hrefs: [`./${TARGET_ENTRY}`, `./${CASE_ENTRY}`] },
];

/**
 * The distinct local targets {@link COUNTED_SOURCES} resolves to, relative to
 * `docs/` — **declared, not derived.** The expected syscall count is
 * `length + 1` (the project root), so computing this list with the code under
 * test would pin nothing; the test cross-checks the declaration against
 * `linkTargetPaths` instead, and both the count and the fixture move together.
 */
const COUNTED_DISTINCT_TARGETS: readonly string[] = [
  TARGET_ENTRY,
  `${SUB_DIR}/${NESTED_ENTRY}`,
  CASE_ENTRY,
];

/** Materialize the fixture tree under `docs/`. */
async function createFixture(tempDir: string): Promise<string> {
  const docsDir = safePath.join(tempDir, 'docs');
  await fs.mkdir(safePath.join(docsDir, SUB_DIR), { recursive: true });
  await fs.writeFile(safePath.join(docsDir, SOURCE_ENTRY), '# Source\n', 'utf-8');
  await fs.writeFile(safePath.join(docsDir, TARGET_ENTRY), '# Target\n\n## Section A\n', 'utf-8');
  await fs.writeFile(safePath.join(docsDir, CASE_ENTRY), '# Case\n', 'utf-8');
  return docsDir;
}

/** Turn the declarative cases into the `{ link, sourceFilePath }` entries the fill takes. */
function toEntries(cases: readonly LinkCase[], sourceFile: string): LinkEntry[] {
  return cases.map((testCase) => ({
    link: createLink(testCase.type, testCase.href),
    sourceFilePath: sourceFile,
  }));
}

/** Resolve a case list and name its local targets — the whole of pass 1′. */
function targetsOf(
  cases: readonly LinkCase[],
  sourceFile: string,
  projectRoot?: string,
): string[] {
  return linkTargetPaths(resolveLinkEntries(toEntries(cases, sourceFile), projectRoot));
}

/** The judge's options for a group, carrying `projectRoot` only when there is one. */
function judgeOptions(
  tables: LinkFactTables,
  projectRoot: string | undefined,
  skipGitIgnoreCheck: boolean,
): JudgeLinkOptions {
  return {
    ...tables,
    skipGitIgnoreCheck,
    ...(projectRoot !== undefined && { projectRoot }),
  };
}

/** Resolve once, fill once over a whole group, then judge every entry against those tables. */
async function fillThenJudge(
  entries: readonly LinkEntry[],
  fragments: FragmentIndex,
  projectRoot: string | undefined,
  { skipGitIgnoreCheck = true, fsCache = new FsLookupCache() } = {},
) {
  const resolved = resolveLinkEntries(entries, projectRoot);
  const policy = { skipGitIgnoreCheck, ...(projectRoot !== undefined && { projectRoot }) };
  const tables = await fillLinkFacts(resolved, fsCache, policy);
  const options = judgeOptions(tables, projectRoot, skipGitIgnoreCheck);
  return {
    tables,
    judge: () => resolved.map((entry) => judgeLink(entry, fragments, options)),
  };
}

/** The one-shot lane: `validateLink` per entry, exactly as ~30 existing tests call it. */
async function validateOneAtATime(
  entries: readonly LinkEntry[],
  fragments: FragmentIndex,
  projectRoot: string | undefined,
) {
  const results = [];
  for (const entry of entries) {
    results.push(
      await validateLink(entry.link, entry.sourceFilePath, fragments, {
        fsCache: new FsLookupCache(),
        skipGitIgnoreCheck: true,
        ...(projectRoot !== undefined && { projectRoot }),
      }),
    );
  }
  return results;
}

/** Realpath calls made while `body` runs, counted per route. */
interface RealpathCounts {
  /** `nodeFs.realpathSync` — the route `resolveLocalHref`/`isWithinProject` takes. */
  sync: number;
  /**
   * `nodeFs.realpath`, the callback form — the route the fill takes, because
   * `FsLookupCache.realpath` promisifies exactly this property, per call, off
   * the `node:fs` default object.
   */
  async: number;
}

/**
 * Run `body`, counting realpath syscalls on BOTH routes.
 *
 * Counting one route alone is how a zero-assertion passes for the wrong reason:
 * the fill canonicalizes asynchronously, the resolver synchronously, and a spy
 * on either one is blind to the other.
 */
async function countRealpaths(body: () => Promise<void> | void): Promise<RealpathCounts> {
  const syncSpy = vi.spyOn(nodeFs, 'realpathSync');
  const asyncSpy = vi.spyOn(nodeFs, 'realpath');
  try {
    await body();
    return { sync: syncSpy.mock.calls.length, async: asyncSpy.mock.calls.length };
  } finally {
    syncSpy.mockRestore();
    asyncSpy.mockRestore();
  }
}

/** One fill's async realpath traffic: how many calls, and how far they overlapped. */
interface RealpathWave {
  /** `nodeFs.realpath` calls issued while `body` ran. */
  calls: number;
  /**
   * Most calls in flight at once. Equal to `calls` when they were all issued as
   * one batch; `1` when each awaited the previous.
   */
  peak: number;
}

/**
 * Run `body`, recording the async realpath calls it issues AND their overlap.
 *
 * ⚠️ **The count alone cannot see a serialised fill, so this instrument records
 * both.** `FsLookupCache` memoizes by path, so replacing the single batched
 * `fillRealpaths` with a loop that fills one target at a time against the SAME
 * cache makes *exactly the same number of syscalls* — the defect is the `await`
 * between them, not a repeat. Overlap is the only observable that separates the
 * two. (The count is what catches the other mutation: a fresh cache per target,
 * which re-canonicalizes the run-constant project root once per link — ledger
 * D8's original defect.)
 *
 * The mock calls through to the real `realpath`, so answers are unchanged; it
 * only brackets the call to maintain the in-flight counter.
 */
async function traceRealpathWave(body: () => Promise<void>): Promise<RealpathWave> {
  const realpath = nodeFs.realpath;
  let calls = 0;
  let inFlight = 0;
  let peak = 0;

  const spy = vi.spyOn(nodeFs, 'realpath').mockImplementation(((
    targetPath: string,
    done: (error: NodeJS.ErrnoException | null, resolvedPath: string) => void,
  ) => {
    calls++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    realpath(targetPath, (error, resolvedPath) => {
      inFlight--;
      done(error, resolvedPath);
    });
  }) as never);

  try {
    await body();
  } finally {
    spy.mockRestore();
  }

  return { calls, peak };
}

describe('link validation fill/judge split', () => {
  const suite = setupAsyncTempDirSuite('link-validator-fill-judge-');
  let tempDir: string;
  let docsDir: string;
  let sourceFile: string;
  let fragments: FragmentIndex;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    docsDir = await createFixture(tempDir);
    sourceFile = safePath.join(docsDir, SOURCE_ENTRY);
    fragments = fragmentIndex([
      [sourceFile, new Set(['source'])],
      [safePath.join(docsDir, TARGET_ENTRY), new Set(['target', 'section-a'])],
    ]);
  });

  it('judges the whole link zoo from one filled table, matching validateLink exactly', async () => {
    const withRoot = toEntries(CASES_WITH_ROOT, sourceFile);
    const withoutRoot = toEntries(CASES_WITHOUT_ROOT, sourceFile);

    const rootLane = await fillThenJudge(withRoot, fragments, tempDir);
    const rootlessLane = await fillThenJudge(withoutRoot, fragments, undefined);

    // Nothing throws: every path the judge asks about has a row in the table
    // the fill built — the invariant `linkTargetPaths` exists to hold.
    const judgedWithRoot = rootLane.judge();
    const judgedWithoutRoot = rootlessLane.judge();

    expect(judgedWithRoot).toEqual(await validateOneAtATime(withRoot, fragments, tempDir));
    expect(judgedWithoutRoot).toEqual(
      await validateOneAtATime(withoutRoot, fragments, undefined),
    );

    // Positive control on the fixture itself: this zoo really does produce
    // issues, so the deep-equality above is not comparing two empty lanes.
    expect(judgedWithRoot.filter(Boolean).length).toBeGreaterThan(0);
    expect(judgedWithoutRoot[0]?.code).toBe('LINK_BROKEN_FILE');
  });

  it('resolves each root-absolute link exactly once across fill and judge', async () => {
    const entries = toEntries(ROOT_ABSOLUTE_CASES, sourceFile);

    // The baseline is MEASURED, not assumed: one `resolveLocalHref` per link is
    // exactly what the pre-split `validateLocalFileLink` cost. Re-resolving in
    // the judge doubled it — a net I/O regression in a change whose whole point
    // was to remove syscalls.
    const oneResolutionEach = await countRealpaths(() => {
      for (const { link, sourceFilePath } of entries) {
        resolveLocalHref(link.href, sourceFilePath, tempDir);
      }
    });
    // Positive control: the fixture really is filesystem-dependent to resolve.
    expect(oneResolutionEach.sync).toBeGreaterThan(0);

    const fillAndJudge = await countRealpaths(async () => {
      const lane = await fillThenJudge(entries, fragments, tempDir);
      lane.judge();
    });

    expect(fillAndJudge.sync).toBe(oneResolutionEach.sync);
    // This lane skips git-ignore checking, so the realpath COLUMN is gated off
    // entirely — the async route must not fire either.
    expect(fillAndJudge.async).toBe(0);
  });

  it('does every directory listing and every realpath in the fill — the judge does neither', async () => {
    const entries = toEntries(CASES_WITH_ROOT, sourceFile);
    const readdirSpy = vi.spyOn(fs, 'readdir');
    // Both realpath spies go on the `node:fs` DEFAULT object: the fill
    // promisifies `nodeFs.realpath` per call, and `resolveLocalHref` calls
    // `nodeFs.realpathSync`. A spy on `node:fs/promises`'s `realpath` would
    // attach fine and count zero — the fill never goes that way.
    const realpathSpy = vi.spyOn(nodeFs, 'realpath');
    const realpathSyncSpy = vi.spyOn(nodeFs, 'realpathSync');

    try {
      // skipGitIgnoreCheck FALSE and no GitTracker — the configuration the
      // registry actually runs in whenever it has no tracker to thread through,
      // and the only one in which the judge can reach the realpath column at all.
      const lane = await fillThenJudge(entries, fragments, tempDir, {
        skipGitIgnoreCheck: false,
      });

      // Positive controls FIRST: without them, the zeroes below would also pass
      // for spies that never attached to the objects production code calls.
      expect(readdirSpy.mock.calls.length).toBeGreaterThan(0);
      expect(realpathSpy.mock.calls.length).toBeGreaterThan(0);
      expect(realpathSyncSpy.mock.calls.length).toBeGreaterThan(0);

      readdirSpy.mockClear();
      realpathSpy.mockClear();
      realpathSyncSpy.mockClear();
      lane.judge();

      // The listing column IS filled: zero listings at judgement time.
      expect(readdirSpy).not.toHaveBeenCalled();
      // So is the realpath column — on BOTH routes of `node:fs`. The fill uses
      // the async callback form, the resolver the sync one, so a zero on either
      // alone would be a confident zero about a syscall the other route makes.
      expect(realpathSpy).not.toHaveBeenCalled();
      expect(realpathSyncSpy).not.toHaveBeenCalled();
    } finally {
      readdirSpy.mockRestore();
      realpathSpy.mockRestore();
      realpathSyncSpy.mockRestore();
    }
  });

  it('fills a realpath column the judge can read for the whole zoo, project root included', async () => {
    const entries = toEntries(CASES_WITH_ROOT, sourceFile);

    const lane = await fillThenJudge(entries, fragments, tempDir, {
      skipGitIgnoreCheck: false,
    });

    // `realpathFrom` throws on a missing row, so a fill set that failed to cover
    // the judged set surfaces here as a crash rather than a wrong answer. This
    // is the agreement test for the realpath column, with the gate OPEN.
    expect(() => lane.judge()).not.toThrow();

    // The project root is a row of its own — half the syscalls the column
    // removes were re-canonicalizing this one run-constant path per link.
    expect(lane.tables.realpaths.has(tempDir)).toBe(true);
  });

  it('canonicalizes each distinct target once and the project root once, in one wave', async () => {
    // The bite's headline claim is a COUNT, so it needs a counted assertion. The
    // two mutations this kills both leave every verdict identical: (1) a loop
    // awaiting `fillRealpaths` per target against the shared cache — same rows,
    // same answers, serialised; (2) the same loop with a FRESH FsLookupCache per
    // target, which reinstates one project-root realpath per link, i.e. exactly
    // the ledger-D8 defect this change exists to remove.
    await fs.writeFile(safePath.join(docsDir, OTHER_ENTRY), '# Other\n', 'utf-8');
    await fs.writeFile(safePath.join(docsDir, SUB_DIR, NESTED_ENTRY), '# Nested\n', 'utf-8');

    const entries = COUNTED_SOURCES.flatMap(({ source, hrefs }) =>
      toEntries(
        hrefs.map((href) => ({ type: 'local_file' as const, href })),
        safePath.join(docsDir, source),
      ),
    );
    // Resolved OUTSIDE the traced body on purpose: the root-absolute href
    // realpaths *synchronously* while resolving, and that cost belongs to pass
    // 1′ step 1, not to the column under test.
    const resolved = resolveLinkEntries(entries, tempDir);

    // Ground the expected number in the fixture rather than in a magic literal:
    // these are the targets the declaration says those five links reach, and the
    // `+ 1` is the run-constant project root.
    const expectedTargets = COUNTED_DISTINCT_TARGETS.map((rel) => safePath.join(docsDir, rel));
    const sorted = (paths: readonly string[]) =>
      [...paths].sort((a, b) => a.localeCompare(b));
    expect(sorted([...new Set(linkTargetPaths(resolved))])).toEqual(sorted(expectedTargets));
    const expectedCalls = expectedTargets.length + 1;

    const wave = await traceRealpathWave(async () => {
      const tables = await fillLinkFacts(resolved, new FsLookupCache(), {
        projectRoot: tempDir,
        skipGitIgnoreCheck: false,
      });
      expect(tables.realpaths.size).toBe(expectedCalls);
    });

    // De-duplicated, and the root canonicalized ONCE: five links, three distinct
    // targets, one project root. A fresh cache per target costs 2× the targets.
    expect(wave.calls).toBe(expectedCalls);
    // One wave: every call was in flight before any of them returned. A loop
    // awaiting per target against the shared cache makes the SAME number of
    // calls — the count above is structurally blind to it, this is not.
    expect(wave.peak).toBe(expectedCalls);
  });

  it('fills NO realpath column, and makes no realpath syscall, when the judge cannot reach it', async () => {
    const entries = toEntries(CASES_WITH_ROOT, sourceFile);
    // Resolved outside every counted body: resolution realpaths on its own, and
    // that cost belongs to pass 1′ step 1, not to the column under test.
    const resolved = resolveLinkEntries(entries, tempDir);

    // Gate CLOSED (git-ignore checking off): gitIgnoreSafetyIssue returns before
    // it asks for a canonical path, so filling one would be pure added syscalls
    // — the exact regression this column exists to remove.
    const skipped = await countRealpaths(async () => {
      const tables = await fillLinkFacts(resolved, new FsLookupCache(), {
        projectRoot: tempDir,
        skipGitIgnoreCheck: true,
      });
      expect(tables.realpaths.size).toBe(0);
      // The gate is per column: the listing column is filled either way.
      expect(tables.siblingNames.size).toBeGreaterThan(0);
    });
    expect(skipped.sync + skipped.async).toBe(0);

    // Gate CLOSED the other way: no projectRoot to be within.
    const rootless = await countRealpaths(async () => {
      const tables = await fillLinkFacts(resolved, new FsLookupCache(), {
        skipGitIgnoreCheck: false,
      });
      expect(tables.realpaths.size).toBe(0);
    });
    expect(rootless.sync + rootless.async).toBe(0);

    // Positive control: the SAME corpus does fill, and does realpath, with the
    // gate open. Without this the two zeroes above are equally satisfied by a
    // fill that never canonicalizes anything.
    const filled = await countRealpaths(async () => {
      const tables = await fillLinkFacts(resolved, new FsLookupCache(), {
        projectRoot: tempDir,
        skipGitIgnoreCheck: false,
      });
      expect(tables.realpaths.size).toBeGreaterThan(0);
      expect(tables.realpaths.has(tempDir)).toBe(true);
    });
    expect(filled.async).toBeGreaterThan(0);
  });

  it('gates the fill on exactly the condition the judge short-circuits on', () => {
    // One predicate, two call sites: a duplicated inline condition on either
    // side is a latent crash, because realpathFrom throws on a missing row.
    expect(needsRealpathColumn({ projectRoot: '/project', skipGitIgnoreCheck: false })).toBe(true);
    expect(needsRealpathColumn({ projectRoot: '/project' })).toBe(true);
    expect(needsRealpathColumn({ projectRoot: '/project', skipGitIgnoreCheck: true })).toBe(false);
    expect(needsRealpathColumn({ skipGitIgnoreCheck: false })).toBe(false);
    expect(needsRealpathColumn({})).toBe(false);
  });

  it('refuses to judge a local link that carries no resolution', () => {
    const unresolved: ResolvedLinkEntry = {
      link: createLink('local_file', `./${TARGET_ENTRY}`),
      sourceFilePath: sourceFile,
    };

    expect(() =>
      judgeLink(unresolved, fragments, {
        siblingNames: new Map<string, readonly string[] | null>(),
        realpaths: new Map<string, string>(),
        skipGitIgnoreCheck: true,
      }),
    ).toThrow(/resolveLinkEntries/);
  });

  it('carries every ValidateLinkOptions field to the judge — and never the cache', () => {
    // `Required<...>` is half the pin: adding a field to ValidateLinkOptions
    // breaks this literal at compile time. The key-set assertion is the other
    // half: adding a field to JudgeLinkOptions without teaching
    // judgeOptionsFrom to carry it breaks it here rather than in production.
    const everyField: Required<ValidateLinkOptions> = {
      fsCache: new FsLookupCache(),
      projectRoot: '/project',
      skipGitIgnoreCheck: false,
      gitTracker: {} as unknown as Required<ValidateLinkOptions>['gitTracker'],
      checkHtmlAnchors: true,
      deferredArtifacts: {} as unknown as Required<ValidateLinkOptions>['deferredArtifacts'],
    };

    const carried = judgeOptionsFrom(everyField, {
      siblingNames: new Map<string, readonly string[] | null>(),
      realpaths: new Map<string, string>(),
    });

    expect(Object.keys(carried).sort((a, b) => a.localeCompare(b))).toEqual([
      'checkHtmlAnchors',
      'deferredArtifacts',
      'gitTracker',
      'projectRoot',
      'realpaths',
      'siblingNames',
      'skipGitIgnoreCheck',
    ]);
    // `fsCache` must not travel — JudgeLinkOptions exists to withhold the
    // handle, and a `{ ...options }` spread would smuggle it past the type.
    expect(Object.keys(carried)).not.toContain('fsCache');
  });

  describe('linkTargetPaths', () => {
    it('returns exactly the resolved local targets', () => {
      expect(
        targetsOf(
          [
            { type: 'local_file', href: `./${TARGET_ENTRY}` },
            { type: 'local_directory', href: `./${SUB_DIR}` },
            { type: 'local_file', href: `./${TARGET_ENTRY}#section-a` },
          ],
          sourceFile,
          tempDir,
        ),
      ).toEqual([
        safePath.join(docsDir, TARGET_ENTRY),
        safePath.join(docsDir, SUB_DIR),
        safePath.join(docsDir, TARGET_ENTRY),
      ]);
    });

    it('contributes nothing for anchor, external, email and unknown links', () => {
      expect(
        targetsOf(
          [
            { type: 'anchor', href: '#source' },
            { type: 'external', href: 'https://example.com/x' },
            { type: 'email', href: 'mailto:a@b.c' },
            { type: 'unknown', href: 'tel:+15555550100' },
          ],
          sourceFile,
          tempDir,
        ),
      ).toEqual([]);
    });

    it('contributes nothing for links that fail to resolve', () => {
      const escaping: readonly LinkCase[] = [{ type: 'local_file', href: '/../escape.md' }];
      const rootless: readonly LinkCase[] = [
        { type: 'local_file', href: `/docs/${TARGET_ENTRY}` },
      ];

      expect(targetsOf(escaping, sourceFile, tempDir)).toEqual([]); // absolute_escapes_root
      expect(targetsOf(rootless, sourceFile)).toEqual([]); // absolute_no_root
    });
  });

  it('lists each distinct target directory once for a whole registry run', async () => {
    const otherDoc = safePath.join(docsDir, OTHER_ENTRY);
    await fs.writeFile(
      otherDoc,
      `# Other\n\n[a](./${TARGET_ENTRY})\n[b](./${SUB_DIR}/missing.md)\n`,
      'utf-8',
    );
    await fs.writeFile(
      safePath.join(docsDir, SOURCE_ENTRY),
      `# Source\n\n[a](./${TARGET_ENTRY})\n[b](./${CASE_ENTRY})\n[c](./${SUB_DIR}/also-missing.md)\n`,
      'utf-8',
    );

    const registry = ResourceRegistry.empty(tempDir);
    await registry.addResource(safePath.join(docsDir, SOURCE_ENTRY));
    await registry.addResource(otherDoc);

    const readdirSpy = vi.spyOn(FsLookupCache.prototype, 'readdir');
    try {
      await registry.validate({ skipGitIgnoreCheck: true });

      // Five local links across two resources, resolving into exactly two
      // distinct directories (docs/ and docs/sub/) — the listing count follows
      // the directories, not the links.
      expect(readdirSpy).toHaveBeenCalledTimes(2);
    } finally {
      readdirSpy.mockRestore();
    }
  });
});

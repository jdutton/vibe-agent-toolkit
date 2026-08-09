/* eslint-disable security/detect-non-literal-fs-filename -- tempDir paths are test-generated, safe in test context */
/**
 * The fill/judge split in link validation.
 *
 * Link validation runs in two passes: {@link resolveLinkEntries} resolves every
 * link exactly once, {@link linkTargetPaths} reads the local targets off those
 * resolutions, `fillSiblingNames` lists their parent directories once
 * (concurrently), and {@link judgeLink} decides every link synchronously against
 * the filled table.
 *
 * ⭐ **The agreement test is the load-bearing one.** The table lookup THROWS on a
 * missing row, so if the fill set ever diverges from the set of paths the judge
 * asks about, link validation crashes rather than answering wrongly. `judges the
 * whole link zoo …` below is what proves the two sets agree, over every link
 * variety the judge handles — and, by deep-equalling the result against the
 * one-shot `validateLink`, that the split moved no output.
 *
 * ⚠️ **The judge is NOT free of I/O, and the tests here say so in numbers.** The
 * fill materialises exactly one column — the directory listing — so `readdir` in
 * the judge is pinned at zero. `realpathSync` is pinned at a *non-zero* number,
 * because the `isWithinProject` fact `gitIgnoreSafetyIssue` needs is not filled.
 * Both spies carry a positive control: an assertion that a spy counted zero is
 * equally satisfied by a spy that never attached. They patch the *default
 * export's* property (`node:fs`, `node:fs/promises`) — a spy attached to a
 * dynamic-import namespace binding is a different object and silently
 * under-counts.
 */
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';

import {
  FsLookupCache,
  fillSiblingNames,
  safePath,
  setupAsyncTempDirSuite,
  type SiblingNamesTable,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fragmentIndex,
  judgeLink,
  judgeOptionsFrom,
  linkTargetPaths,
  resolveLinkEntries,
  validateLink,
  type FragmentIndex,
  type JudgeLinkOptions,
  type LinkEntry,
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
 * `realpathSync` calls the judge still makes over {@link CASES_WITH_ROOT} with
 * git-ignore checking ON: four *existing* local targets (`./target.md`,
 * `/docs/target.md`, `./target.md#section-a`, `./sub`) each reach
 * `gitIgnoreSafetyIssue` → `isWithinProject`, which is two `realpathSync` apiece.
 * The other seven never get there — they are anchor/external/email/unknown, or
 * they fail resolution or existence first.
 *
 * ⚠️ **This number is the un-filled realpath column, not a target.** It must go
 * to ZERO the day the fill materialises `isWithinProject` the way it already
 * materialises the directory listing. Until then, "the judge does no I/O" is a
 * false statement and this constant is the proof.
 */
const JUDGE_REALPATH_CALLS = 8;

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
  siblingNames: SiblingNamesTable,
  projectRoot: string | undefined,
  skipGitIgnoreCheck: boolean,
): JudgeLinkOptions {
  return {
    siblingNames,
    skipGitIgnoreCheck,
    ...(projectRoot !== undefined && { projectRoot }),
  };
}

/** Resolve once, fill once over a whole group, then judge every entry against that one table. */
async function fillThenJudge(
  entries: readonly LinkEntry[],
  fragments: FragmentIndex,
  projectRoot: string | undefined,
  { skipGitIgnoreCheck = true, fsCache = new FsLookupCache() } = {},
) {
  const resolved = resolveLinkEntries(entries, projectRoot);
  const siblingNames = await fillSiblingNames(linkTargetPaths(resolved), fsCache);
  const options = judgeOptions(siblingNames, projectRoot, skipGitIgnoreCheck);
  return {
    siblingNames,
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

/** How many times `fs.realpathSync` is called while `body` runs. */
async function countRealpathSync(body: () => Promise<void> | void): Promise<number> {
  const spy = vi.spyOn(nodeFs, 'realpathSync');
  try {
    await body();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
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
    const oneResolutionEach = await countRealpathSync(() => {
      for (const { link, sourceFilePath } of entries) {
        resolveLocalHref(link.href, sourceFilePath, tempDir);
      }
    });
    // Positive control: the fixture really is filesystem-dependent to resolve.
    expect(oneResolutionEach).toBeGreaterThan(0);

    const fillAndJudge = await countRealpathSync(async () => {
      const lane = await fillThenJudge(entries, fragments, tempDir);
      lane.judge();
    });

    expect(fillAndJudge).toBe(oneResolutionEach);
  });

  it('does every directory listing in the fill — but still realpaths in the judge', async () => {
    const entries = toEntries(CASES_WITH_ROOT, sourceFile);
    const readdirSpy = vi.spyOn(fs, 'readdir');
    const realpathSpy = vi.spyOn(nodeFs, 'realpathSync');

    try {
      // skipGitIgnoreCheck FALSE and no GitTracker — the configuration the
      // registry actually runs in whenever it has no tracker to thread through.
      const lane = await fillThenJudge(entries, fragments, tempDir, {
        skipGitIgnoreCheck: false,
      });

      // Positive controls FIRST: without them, the counts below would also pass
      // for spies that never attached to the objects production code calls.
      expect(readdirSpy.mock.calls.length).toBeGreaterThan(0);
      expect(realpathSpy.mock.calls.length).toBeGreaterThan(0);

      readdirSpy.mockClear();
      realpathSpy.mockClear();
      lane.judge();

      // The listing column IS filled: zero listings at judgement time.
      expect(readdirSpy).not.toHaveBeenCalled();
      // The realpath column is NOT. See JUDGE_REALPATH_CALLS — this number is a
      // defect being measured, not a property being preserved.
      expect(realpathSpy).toHaveBeenCalledTimes(JUDGE_REALPATH_CALLS);
    } finally {
      readdirSpy.mockRestore();
      realpathSpy.mockRestore();
    }
  });

  it('refuses to judge a local link that carries no resolution', () => {
    const unresolved: ResolvedLinkEntry = {
      link: createLink('local_file', `./${TARGET_ENTRY}`),
      sourceFilePath: sourceFile,
    };

    expect(() =>
      judgeLink(unresolved, fragments, {
        siblingNames: new Map<string, readonly string[] | null>(),
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

    const carried = judgeOptionsFrom(
      everyField,
      new Map<string, readonly string[] | null>(),
    );

    expect(Object.keys(carried).sort((a, b) => a.localeCompare(b))).toEqual([
      'checkHtmlAnchors',
      'deferredArtifacts',
      'gitTracker',
      'projectRoot',
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
    const otherDoc = safePath.join(docsDir, 'other.md');
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

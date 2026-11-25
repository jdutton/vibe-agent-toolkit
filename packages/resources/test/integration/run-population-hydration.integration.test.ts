/**
 * A warm run's registry is built from the store's blob facts, and it is the
 * cold registry: the same resources, the same not-admitted logs, the same
 * findings, in the same order.
 *
 * Each case runs one tree three ways: COLD (a store miss, so the run derives and
 * files the population), WARM (the same store, now a hit) and STORE-OFF (no
 * store at all). Warm must equal both, and must have read, hashed and parsed
 * nothing for a member the store answers.
 *
 * Through the store double (`FakeFactStore`): these cases need what only a double
 * offers (evicting one key's rows, a parse pool that throws for one document).
 * The same parity through the real SQLite store, rows decoded from disk, is
 * projection-sqlite's `warm-registry-hydration.integration.test.ts`.
 *
 * The tree is a committed repository, as every stored tree is: only a file whose
 * bytes the store's key reads is admitted from the store, and git is what says
 * which files those are.
 */

import { chmod, cp, mkdir, open, rm, writeFile } from 'node:fs/promises';

import { readWorkCounters, safePath, VatError } from '@vibe-agent-toolkit/utils';
import { GIT_FAILED_CODE, GIT_NO_ANSWER_CODE, GitTracker, gitTreeKey, runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { createTempDirAsync, removeTempDir, type WorkSpent, workSpentNow, workSpentSince } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParserKind } from '../../src/content-key.js';
import { ParseCache } from '../../src/parse-cache.js';
import { ParseDispatcher, type ParsePoolPolicy } from '../../src/parse-dispatcher.js';
import { isParseLimitError, isParserThrewError, reviveParserThrow } from '../../src/parse-limits.js';
import { POPULATION_PARSE_LIMITS, RunContentCache } from '../../src/projection/content-cache.js';
import { GitCrawlSource } from '../../src/projection/crawl-source.js';
import type { PopulationCache } from '../../src/projection/merge.js';
import { IGNORE_HOME_SETTLEMENT, RunPopulation, StoreQuestionUnavailableError } from '../../src/projection/run-population.js';
import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ProjectConfig } from '../../src/schemas/project-config.js';
import type { ResourceMetadata } from '../../src/schemas/resource-metadata.js';
import { skillTextFactsOf } from '../../src/skill-text/core.js';
import { SKILL_TEXT_DECLARATION } from '../../src/skill-text/declaration.js';
import { FailingBlobStore, FakeFactStore } from '../fake-fact-store.js';
import { failingParsePolicy } from '../helpers/failing-parse-policy.js';
import { createCommittedRepo } from '../test-helpers.js';

/** A document the injected parse pool fails, by this marker in its text. */
const PARSE_FAILS = 'PARSE-FAILS-HERE';

/** The tree every case starts from: links between documents, a frontmatter id, an HTML page, a JSON file. */
const TREE: Readonly<Record<string, string>> = {
  'README.md': '---\nid: home\n---\n# Home\n\nSee [the guide](./docs/guide.md#usage) and [missing](./docs/nope.md).\n',
  'docs/guide.md': '# Guide\n\n## Usage\n\nBack [home](../README.md) and [a ref][r].\n\n[r]: ./page.html\n',
  'docs/page.html': '<!DOCTYPE html><h1 id="top">Page</h1><a href="./guide.md">Guide</a>\n',
  'docs/data.json': '{ "see": "[a link](./guide.md)" }\n',
};

const INCLUDE = ['**/*.md', '**/*.html', '**/*.json'];

const PREFIX = 'vat-run-population-hydration-';

let root = '';
const store = { current: new FakeFactStore() };

/** {@link TREE}, committed once: every case's root is a copy of it, or of a repository built from one. */
let committedTree = '';

beforeAll(() => {
  // Both lanes parse for real: the on-disk parse cache would serve a cold run what an earlier
  // build parsed, and count its hits as lookups a warm run must not make.
  vi.stubEnv('VAT_CACHE', '0');
  committedTree = createCommittedRepo(PREFIX, { files: { ...TREE }, gitignore: '' });
});

afterAll(() => {
  vi.unstubAllEnvs();
  removeTempDir(committedTree);
});

/**
 * A copy of a committed repository, its `.git` included: the repository committing the same
 * files afresh would leave, without starting git.
 *
 * @param template - The repository to copy
 * @returns The copy's absolute path, in a temp directory of its own
 */
async function copyOfRepo(template: string): Promise<string> {
  const copy = await createTempDirAsync(PREFIX);
  await cp(template, copy, { recursive: true });
  return copy;
}

/** Remove the current {@link root}, made readable first whatever a case left unreadable. */
async function removeRoot(): Promise<void> {
  await chmod(root, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

/**
 * Give every case of the calling `describe` its own copy of `template()` and an empty store.
 *
 * @param template - The committed repository each case's root copies
 */
function eachCaseCopies(template: () => string): void {
  beforeEach(async () => {
    root = await copyOfRepo(template());
    store.current = new FakeFactStore();
  });
  afterEach(removeRoot);
}

/** Start the case from an empty store, in place of the one its `describe` handed it. */
function fromEmptyStore(): void {
  store.current = new FakeFactStore();
}

/**
 * @param relative - A root-relative path
 * @param content - Its bytes
 */
async function plant(relative: string, content: string | Buffer): Promise<void> {
  const path = safePath.join(root, relative);
  await mkdir(safePath.join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

/**
 * Plant a document one byte past the population's input cap. Sparse, so it costs no disk.
 *
 * @param relative - A root-relative path
 * @returns Its absolute path
 */
async function plantPastCap(relative: string): Promise<string> {
  const path = safePath.join(root, relative);
  const handle = await open(path, 'w');
  try {
    await handle.truncate(POPULATION_PARSE_LIMITS.inputBytes + 1);
  } finally {
    await handle.close();
  }
  return path;
}

/** What one run's registry produced: everything validate reports from. */
interface RunOutput {
  readonly resources: readonly ResourceMetadata[];
  readonly notAdmitted: ReturnType<ResourceRegistry['getNotAdmitted']>;
  readonly issues: unknown;
  readonly work: WorkSpent;
  readonly outcome: string;
}

/** A pool that throws a parser's own error for a document carrying {@link PARSE_FAILS}, and parses the rest for real. */
function failingPolicy(): ParsePoolPolicy {
  const failure = reviveParserThrow({ name: 'TypeError', message: 'bad input', code: 'ERR_INVALID_ARG_TYPE' }, true);
  return failingParsePolicy((content) => (content.includes(PARSE_FAILS) ? failure : undefined));
}

/** What a case varies about one run beyond whether it has the store. */
interface RunVariation {
  /** The registry's project config: a view whose collections route a file differently. */
  readonly config?: ProjectConfig;
  /** The run dispatcher's own parse limits, as a programmatic caller may pass them. */
  readonly limits?: ParsePoolPolicy['limits'];
  /** The frontmatter field the registry takes a resource's id from. */
  readonly idField?: string;
  /**
   * Key the store as the CLI keys it (`gitTreeKey`), declining where git cannot key the tree,
   * instead of under the suite's fixed key.
   */
  readonly gitKeyed?: boolean;
  /** The trees the run declares it writes; none by default. */
  readonly outputs?: readonly string[];
  /** What building the home population fails with (its collections lookup rejects), if anything. */
  readonly homeFault?: Error;
  /** The run's home, when it is not the suite's repository root. */
  readonly home?: string;
  /** What opening the run's store fails with, if anything: the run's connection and the questions' alike. */
  readonly storeFault?: Error;
  /** What opening the questions' own connection fails with, if anything, in place of {@link storeFault}. */
  readonly questionStoreFault?: Error;
  /**
   * What every write through the questions' own connection fails with, if
   * anything: another process holding the lock, met by a connection that does
   * not wait. The run's own connection writes as ever.
   */
  readonly questionWriteFault?: Error;
  /** What every blob tier read through the questions' own connection fails with, if anything. */
  readonly questionBlobReadFault?: Error;
}

/**
 * The store as a run of `variation` opens it: under the suite's fixed key, or under git's key
 * of the tree as it is now, or none where git declines to key it.
 *
 * @param variation - What the run varies
 * @returns The cache, or `undefined` when the run has no store
 */
function cacheOf(variation: RunVariation): PopulationCache | undefined {
  if (variation.gitKeyed !== true) return { store: store.current, treeHash: 'hydration-suite', treeUnchanged: () => true };
  const key = gitTreeKey({ cwd: root });
  if (!key.ok) return undefined;
  return {
    store: store.current,
    treeHash: key.hash,
    treeUnchanged: () => {
      const now = gitTreeKey({ cwd: root });
      return now.ok && now.hash === key.hash;
    },
  };
}

/**
 * Crawl and validate the tree in one run of its own.
 *
 * The store's key is fixed, as a key that does not move is the case under test:
 * whatever the tree's bytes, a warm run is a hit.
 *
 * @param withStore - Whether the run has the suite's store
 * @param variation - What else this run varies
 * @returns What the run's registry produced, and the work it spent
 */
async function runOnce(withStore: boolean, variation: RunVariation = {}): Promise<RunOutput> {
  return withRun(withStore, variation, async (population, before) => {
    const registry = ResourceRegistry.forRun(population, {
      baseDir: root,
      gitTracker: population.gitTracker,
      ...(variation.config !== undefined && { config: variation.config }),
      ...(variation.idField !== undefined && { idField: variation.idField }),
    });
    const crawl = await registry.crawl({
      baseDir: root,
      include: INCLUDE,
      outputs: [],
      unreadable: 'refuse',
      ignoredRefusals: 'record',
      populationSource: population.source,
    });
    const after = workSpentNow();
    const issues = (await registry.validate()).issues;
    return {
      resources: registry.getAllResources(),
      notAdmitted: registry.getNotAdmitted(),
      issues,
      work: workSpentSince(after, before),
      outcome: crawl.population.outcome.stored,
    };
  });
}

/**
 * `cache` with every store write failing with `faults.write` and every blob
 * tier read with `faults.blobRead`, or `cache` itself with neither.
 *
 * @param cache - The cache, if any
 * @param faults - What each write and blob read fails with, if anything
 * @param faults.write - What each write fails with
 * @param faults.blobRead - What each blob tier read fails with
 * @returns The cache the questions open
 */
function callsFailing(
  cache: PopulationCache | undefined,
  faults: { readonly write: Error | undefined; readonly blobRead: Error | undefined },
): PopulationCache | undefined {
  if (cache === undefined) return cache;
  const { store: inner } = cache;
  const failing = <T>(fault: Error | undefined, call: () => Promise<T>): Promise<T> => (fault === undefined ? call() : Promise.reject(fault));
  return {
    ...cache,
    store: {
      writeBlobFacts: (rows) => failing(faults.write, () => inner.writeBlobFacts(rows)),
      writeExtent: (key, rows) => failing(faults.write, () => inner.writeExtent(key, rows)),
      readBlobFacts: (contentKeys, request) => failing(faults.blobRead, () => inner.readBlobFacts(contentKeys, request)),
      readExtent: (key, request) => inner.readExtent(key, request),
      close: () => inner.close(),
    },
  };
}

/**
 * One run of its own: its content cache, dispatcher and population, shut down however `work` ends.
 *
 * @param withStore - Whether the run has the suite's store
 * @param variation - What else this run varies
 * @param work - What the run does, handed the work counters at its start
 * @returns What `work` returns
 */
async function withRun<T>(withStore: boolean, variation: RunVariation, work: (population: RunPopulation, before: WorkSpent) => Promise<T>): Promise<T> {
  const cache: PopulationCache | undefined = withStore
    ? cacheOf(variation)
    : undefined;
  const content = new RunContentCache();
  const policy = { content, ...failingPolicy(), ...(variation.limits !== undefined && { limits: variation.limits }) };
  const dispatcher = new ParseDispatcher(new ParseCache({ enabled: false }), policy);
  const home = variation.home ?? root;
  // One in-process store, which no other process can hold a lock on: the
  // questions open the same one, injected fault included.
  const storeOf = (): Promise<PopulationCache | undefined> => (variation.storeFault === undefined ? Promise.resolve(cache) : Promise.reject(variation.storeFault));
  const population = new RunPopulation({
    root: home,
    outputs: variation.outputs ?? [],
    gitTracker: new GitTracker(home),
    cacheOf: storeOf,
    questionCacheOf: () => (variation.questionStoreFault === undefined ? storeOf() : Promise.reject(variation.questionStoreFault))
      .then((opened) => callsFailing(opened, { write: variation.questionWriteFault, blobRead: variation.questionBlobReadFault })),
    holdsStore: true,
    collectionsFor: () => (variation.homeFault === undefined ? Promise.resolve(undefined) : Promise.reject(variation.homeFault)),
    onHomeSettled: IGNORE_HOME_SETTLEMENT,
  }, { content, dispatcher });
  try {
    return await work(population, workSpentNow());
  } finally {
    await dispatcher.shutdown();
  }
}

/**
 * Crawl under the suite's store, then add one file on its own: what a single-file add throws.
 *
 * @param relative - The root-relative file to add
 * @returns What the add threw
 */
async function addThrows(relative: string): Promise<unknown> {
  return withRun(true, {}, async (population) => {
    const registry = ResourceRegistry.forRun(population, { baseDir: root, gitTracker: population.gitTracker });
    await registry.crawl({ baseDir: root, include: INCLUDE, outputs: [], unreadable: 'refuse', ignoredRefusals: 'record', populationSource: population.source });
    return registry.addResource(safePath.join(root, relative)).then(
      () => { throw new Error(`${relative} was admitted`); },
      (error: unknown) => error,
    );
  });
}

/** Cold (store miss, derive and file), warm (the hit) and store-off, in that order. */
async function threeWays(variation: RunVariation = {}): Promise<{ cold: RunOutput; warm: RunOutput; off: RunOutput }> {
  const cold = await runOnce(true, variation);
  const warm = await runOnce(true, variation);
  const off = await runOnce(false, variation);
  expect([cold.outcome, warm.outcome, off.outcome]).toEqual(['written', 'hit', 'no-store']);
  return { cold, warm, off };
}

/**
 * @param run - One run's output
 * @returns Everything a finding is built from, comparable across runs
 */
function findingsOf(run: RunOutput): unknown {
  return { resources: run.resources, notAdmitted: run.notAdmitted, issues: run.issues };
}

/** Warm's findings are cold's and store-off's. */
function expectWarmIsCold(runs: { cold: RunOutput; warm: RunOutput; off: RunOutput }): void {
  expect(findingsOf(runs.warm)).toEqual(findingsOf(runs.cold));
  expect(findingsOf(runs.warm)).toEqual(findingsOf(runs.off));
}

describe('a warm registry is built from the store and is the cold registry', () => {
  eachCaseCopies(() => committedTree);

  it('admits every member from the blob tier: no read, hash or parse lookup', async () => {
    const { cold, warm, off } = await threeWays();
    expect(warm.resources).toHaveLength(Object.keys(TREE).length);
    expectWarmIsCold({ cold, warm, off });
    expect(JSON.stringify(findingsOf(warm))).toBe(JSON.stringify(findingsOf(cold)));
    expect(warm.work).toEqual({ reads: 0, hashed: 0, parseLookups: 0, admitted: Object.keys(TREE).length });
    expect(cold.work.admitted, 'counted once per admitted file whichever way').toBe(warm.work.admitted);
    // The cold run missed at the extent, before any blob read; the warm run read the tier once
    // for every member it admitted.
    expect(store.current.readBlobFactsCalls).toBe(1);
  });

  it('falls back per key: an evicted key is read and parsed in memory, the rest come from the store', async () => {
    const cold = await runOnce(true);
    const guide = cold.resources.find((resource) => resource.filePath.endsWith('guide.md'));
    if (guide === undefined) throw new Error('the cold run admitted no guide.md');
    store.current.forgetBlobFacts(guide.contentKey);
    const writes = store.current.writeBlobFactsCalls;
    const warm = await runOnce(true);
    expect(warm.outcome).toBe('hit');
    expect(findingsOf(warm)).toEqual(findingsOf(cold));
    expect(warm.work.reads, 'the evicted key alone is read').toBe(1);
    expect(warm.work.hashed).toBe(1);
    expect(store.current.writeBlobFactsCalls, 'a fallback writes nothing').toBe(writes);
  });
});

describe('a stored refusal is the cold refusal', () => {
  eachCaseCopies(() => committedTree);

  it('a document whose parser threw: the same unreadable entry, with no parse', async () => {
    await plant('docs/broken.md', `# Broken\n\n${PARSE_FAILS}\n`);
    const { cold, warm, off } = await threeWays();
    expect(cold.notAdmitted.unreadable.map((entry) => entry.filePath)).toEqual([safePath.join(root, 'docs/broken.md')]);
    expect(cold.notAdmitted.unreadable[0]?.code).toBe('ERR_INVALID_ARG_TYPE');
    expectWarmIsCold({ cold, warm, off });
    expect(warm.work).toMatchObject({ reads: 0, hashed: 0, parseLookups: 0 });
  });

  it('a document past the input cap: the same parse-limit refusal, with no read', async () => {
    const big = await plantPastCap('docs/big.md');
    const { cold, warm, off } = await threeWays();
    expect(cold.notAdmitted.parseRefused.map((entry) => [entry.filePath, entry.code]))
      .toEqual([[big, 'RESOURCE_PARSE_LIMIT_EXCEEDED']]);
    expectWarmIsCold({ cold, warm, off });
    expect(warm.work).toMatchObject({ reads: 0, hashed: 0, parseLookups: 0 });
  });
});

const CANNOT_REFUSE_READ = process.platform === 'win32' || process.getuid?.() === 0;

describe.skipIf(CANNOT_REFUSE_READ)('a member that cannot be read now', () => {
  eachCaseCopies(() => committedTree);

  it('is computed the cold way, so the cold read raises the cold error', async () => {
    const cold = await runOnce(true);
    const guide = safePath.join(root, 'docs/guide.md');
    await chmod(guide, 0o000);
    try {
      const warm = await runOnce(true);
      const off = await runOnce(false);
      expect(warm.outcome).toBe('hit');
      expect(warm.notAdmitted.unreadable.map((entry) => [entry.filePath, entry.code])).toEqual([[guide, 'EACCES']]);
      expect(findingsOf(warm)).toEqual(findingsOf(off));
      expect(warm.resources).toHaveLength(cold.resources.length - 1);
    } finally {
      await chmod(guide, 0o644);
    }
  });

  it('past the input cap too: the cold read error, not the stored size refusal', async () => {
    const big = await plantPastCap('docs/big.md');
    await runOnce(true);
    await chmod(big, 0o000);
    try {
      const warm = await runOnce(true);
      const off = await runOnce(false);
      expect(warm.outcome).toBe('hit');
      expect(off.notAdmitted.unreadable.map((entry) => [entry.filePath, entry.code])).toEqual([[big, 'EACCES']]);
      expect(findingsOf(warm)).toEqual(findingsOf(off));
    } finally {
      await chmod(big, 0o644);
    }
  });
});

describe('a tree whose index hides working-tree bytes from the key has no store', () => {
  eachCaseCopies(() => committedTree);

  // The key is a snapshot of the working tree through a copy of the real index, so a file git is
  // told not to look at (assume-unchanged, skip-worktree) keeps its staged bytes in the hash
  // whatever is on disk. Stored under such a key, facts describe bytes the key does not: git
  // declines to key the tree, on the run that would write the store and on the run that would read it.
  const GUIDE = 'docs/guide.md';
  const EDITED = '# Guide\n\n## Usage\n\nNow [broken](./gone.md).\n';

  for (const flag of ['assume-unchanged', 'skip-worktree'] as const) {
    it(`flagged ${flag} and edited when the store would be written, then reverted and unflagged`, async () => {
      runGitOrThrow(['update-index', `--${flag}`, GUIDE], { cwd: root });
      await plant(GUIDE, EDITED);
      const writing = await runOnce(true, { gitKeyed: true });
      runGitOrThrow(['update-index', `--no-${flag}`, GUIDE], { cwd: root });
      runGitOrThrow(['checkout', '--', GUIDE], { cwd: root });
      const warm = await runOnce(true, { gitKeyed: true });
      const off = await runOnce(false);
      expect(JSON.stringify(writing.issues)).toContain('gone.md');
      expect(JSON.stringify(off.issues)).not.toContain('gone.md');
      expect(findingsOf(warm)).toEqual(findingsOf(off));
      expect(writing.outcome, 'git declined to key the flagged tree').toBe('no-store');
    });

    it(`written clean, then flagged ${flag} and edited before the warm run`, async () => {
      const cold = await runOnce(true, { gitKeyed: true });
      runGitOrThrow(['update-index', `--${flag}`, GUIDE], { cwd: root });
      await plant(GUIDE, EDITED);
      const warm = await runOnce(true, { gitKeyed: true });
      const off = await runOnce(false);
      expect(cold.outcome).toBe('written');
      expect(JSON.stringify(off.issues)).toContain('gone.md');
      expect(findingsOf(warm)).toEqual(findingsOf(off));
      expect(warm.outcome, 'git declined to key the flagged tree').toBe('no-store');
    });
  }
});

describe('files beneath a gitlink are no member of any population', () => {
  eachCaseCopies(() => committedTree);

  // ⚠️ Hydration relies on this. The store's key holds a submodule or nested repository as one
  // gitlink at its HEAD, never its working-tree bytes, so a member beneath one would be hydrated
  // from facts of bytes the key does not describe. The store key must cover such files before they
  // ever become members.
  it('a submodule\'s and an untracked nested repository\'s files are not resources, warm, cold or store-off', async () => {
    const source = createCommittedRepo('vat-run-population-hydration-sub-', { files: { 'note.md': '# Note\n' }, gitignore: '' });
    try {
      runGitOrThrow(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'vendor/sub'], { cwd: root });
      runGitOrThrow(['commit', '-qm', 'submodule'], { cwd: root });
      const nested = safePath.join(root, 'nested');
      await plant('nested/inner.md', '# Inner\n');
      runGitOrThrow(['init', '-q'], { cwd: nested });
      runGitOrThrow(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'n'], { cwd: nested });
      for (const run of [await runOnce(true, { gitKeyed: true }), await runOnce(true, { gitKeyed: true }), await runOnce(false)]) {
        const paths = run.resources.map((resource) => resource.filePath);
        expect(paths.filter((path) => path.includes('/vendor/sub/') || path.includes('/nested/'))).toEqual([]);
        expect(paths).toHaveLength(Object.keys(TREE).length);
      }
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });
});

describe('a warm view routes, adjudicates and refuses as the cold one', () => {
  eachCaseCopies(() => committedTree);

  it('a view whose collection types a file differently from the population computes it under its own parser', async () => {
    const config: ProjectConfig = { resources: { collections: { prose: { include: ['docs/*.json'], mimeType: 'text/markdown' } } } };
    const { cold, warm, off } = await threeWays({ config });
    const data = warm.resources.find((resource) => resource.filePath.endsWith('data.json'));
    expect(data?.links.map((link) => link.href)).toEqual(['./guide.md']);
    expectWarmIsCold({ cold, warm, off });
    expect(warm.work.reads, 'the retyped file alone is read').toBe(1);
  });

  it('two files sharing a frontmatter id: the same first wins and the same collision is reported', async () => {
    await plant('docs/twin.md', '---\nid: home\n---\n# Twin\n');
    const { cold, warm, off } = await threeWays({ idField: 'id' });
    expect(JSON.stringify(off.issues)).toContain('DUPLICATE_RESOURCE_ID');
    expectWarmIsCold({ cold, warm, off });
    expect(warm.work.reads).toBe(0);
  });

  it('a binary .md: the same admission, with no read', async () => {
    await writeFile(safePath.join(root, 'docs/blob.md'), Buffer.from([0x23, 0x20, 0x00, 0x01, 0x02, 0xff, 0x00, 0x0a]));
    const { cold, warm, off } = await threeWays();
    expectWarmIsCold({ cold, warm, off });
    expect(warm.work.reads).toBe(0);
  });

  it('hands every view the frozen facts the cold lane hands it', async () => {
    const { cold, warm } = await threeWays();
    for (const run of [cold, warm]) {
      const home = run.resources.find((resource) => resource.filePath.endsWith('README.md'));
      expect(Object.isFrozen(home?.frontmatter)).toBe(true);
    }
  });
});

describe('a warm run only hydrates under the limits its facts were stored under', () => {
  eachCaseCopies(() => committedTree);

  it('a dispatcher with its own limits computes every file', async () => {
    await runOnce(true);
    const variation = { limits: { timeMs: POPULATION_PARSE_LIMITS.timeMs + 1 } };
    const warm = await runOnce(true, variation);
    const off = await runOnce(false, variation);
    expect(warm.outcome).toBe('hit');
    expect(findingsOf(warm)).toEqual(findingsOf(off));
    expect(warm.work.reads).toBe(Object.keys(TREE).length);
  });
});

describe('a single-file add throws the cold error for a stated refusal', () => {
  eachCaseCopies(() => committedTree);

  it('the parser\'s own throw for a document it failed', async () => {
    await plant('docs/broken.md', `# Broken\n\n${PARSE_FAILS}\n`);
    await runOnce(true);
    const error = await addThrows('docs/broken.md');
    expect(isParserThrewError(error)).toBe(true);
    expect((error as { code?: string }).code).toBe('ERR_INVALID_ARG_TYPE');
  });

  it('the input-cap parse-limit error for a document past the cap', async () => {
    const handle = await open(safePath.join(root, 'docs/big.md'), 'w');
    try {
      await handle.truncate(POPULATION_PARSE_LIMITS.inputBytes + 1);
    } finally {
      await handle.close();
    }
    await runOnce(true);
    const error = await addThrows('docs/big.md');
    expect(isParseLimitError(error) && error.limit).toBe('inputBytes');
  });
});


describe('a blob tier that cannot be read refuses the run', () => {
  eachCaseCopies(() => committedTree);

  it('is never filed as a per-file finding, whatever errno it carries', async () => {
    const failing = new FailingBlobStore();
    store.current = failing;
    await runOnce(true);
    failing.failBlobs = true;
    await expect(runOnce(true)).rejects.toMatchObject({ code: 'PROJECTION_STORE_READ_FAILED' });
  });
});

/** A document the skill-text core matches, planted beside the suite's tree. */
const SKILL = 'docs/skill.md';
const SKILL_TEXT = '# Skill\n\nData as of March 2024.\n\nRun `sed -i x` here.\n';

/** What one run's `storedDocument` answered, and the work the run spent. */
interface DocumentAnswer {
  readonly document: Awaited<ReturnType<RunPopulation['storedDocument']>>;
  readonly work: WorkSpent;
  /** The readability probes (`fs.stat`) the ask itself spent, after the crawl or enumeration. */
  readonly askProbes: number;
}

/** How a run reaches its `storedDocument` call. */
interface DocumentAsk {
  /** Admit the tree through a registry first (the lane's own admissions), rather than only enumerate it. */
  readonly admit?: boolean;
  /** Ask before anything enumerates the home: the ask is the run's first work. */
  readonly first?: boolean;
  /** The parser the file is asked under; markdown by default. */
  readonly parserKind?: ParserKind;
  /** What else this run varies. */
  readonly variation?: RunVariation;
  /** Done after the population is known and before the ask. */
  readonly between?: () => Promise<void>;
}

/**
 * One run that enumerates the home population (or crawls it, with `admit`) and then asks for one file.
 *
 * @param withStore - Whether the run has the suite's store
 * @param relative - The root-relative file to ask for
 * @param ask - How the run reaches the ask
 * @returns The answer and the run's work
 */
async function documentOf(withStore: boolean, relative: string, ask: DocumentAsk = {}): Promise<DocumentAnswer> {
  return withRun(withStore, ask.variation ?? {}, async (population, before) => {
    if (ask.admit === true) {
      const registry = ResourceRegistry.forRun(population, { baseDir: root, gitTracker: population.gitTracker });
      await registry.crawl({ baseDir: root, include: INCLUDE, outputs: [], unreadable: 'refuse', ignoredRefusals: 'record', populationSource: population.source });
    } else if (ask.first !== true) {
      await population.source.enumerate(root, [], 'refuse', { include: INCLUDE, exclude: [], ignoredRefusals: 'record' });
    }
    await ask.between?.();
    const probesBefore = readWorkCounters()['fs.stat'];
    const document = await population.source.storedDocument(safePath.join(root, relative), ask.parserKind ?? 'markdown');
    return { document, work: workSpentSince(workSpentNow(), before), askProbes: readWorkCounters()['fs.stat'] - probesBefore };
  });
}

describe('storedDocument: one file\'s facts, skill-text record included, from the run\'s store alone', () => {
  const expected = skillTextFactsOf(SKILL_TEXT, SKILL_TEXT_DECLARATION);

  /** {@link TREE} with {@link SKILL} committed beside it, built once. */
  let committedWithSkill = '';

  beforeAll(async () => {
    committedWithSkill = await copyOfRepo(committedTree);
    await writeFile(safePath.join(committedWithSkill, SKILL), SKILL_TEXT);
    runGitOrThrow(['add', '-A'], { cwd: committedWithSkill });
    runGitOrThrow(['commit', '-q', '-m', 'skill'], { cwd: committedWithSkill });
  });

  afterAll(() => {
    removeTempDir(committedWithSkill);
  });

  describe('a case that changes the tree has a copy of its own', () => {
    eachCaseCopies(() => committedWithSkill);

    it('says how each stored document was decoded: its blobs row\'s encoding and source', async () => {
      const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SKILL_TEXT, 'utf8')]);
      const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SKILL_TEXT, 'utf16le')]);
      await plant('docs/bom.md', bom);
      await plant('docs/utf16.md', utf16);
      runGitOrThrow(['add', '-A'], { cwd: root });
      runGitOrThrow(['commit', '-q', '-m', 'encodings'], { cwd: root });
      await runOnce(true);
      const decodings = await withRun(true, {}, async (population) => {
        const ask = async (relative: string) => (await population.source.storedDocument(safePath.join(root, relative), 'markdown'))?.decoding;
        return { plain: await ask(SKILL), bom: await ask('docs/bom.md'), utf16: await ask('docs/utf16.md') };
      });
      expect(decodings).toStrictEqual({
        plain: { encoding: 'utf-8', encodingSource: 'assumed' },
        bom: { encoding: 'utf-8', encodingSource: 'bom' },
        utf16: { encoding: 'utf-16le', encodingSource: 'bom' },
      });
    });

    it('opens the one home population a run that writes output crawls with, and serves nothing it writes', async () => {
      // A build: its output tree is gitignored, and the run declares it.
      await plant('.gitignore', 'dist/\n');
      await plant('dist/built.md', SKILL_TEXT);
      runGitOrThrow(['add', '-A'], { cwd: root });
      runGitOrThrow(['commit', '-q', '-m', 'ignore dist'], { cwd: root });
      const outputs = [safePath.join(root, 'dist')];
      const members = { include: INCLUDE, exclude: [], ignoredRefusals: 'record' } as const;
      await withRun(true, { outputs }, (population) => population.source.enumerate(root, outputs, 'refuse', members));
      const warm = await withRun(true, { outputs }, async (population) => {
        const readsBefore = store.current.readExtentCalls;
        // Asked before any crawl, as discovery asks; then the build's own crawl of its home.
        const skill = await population.source.storedDocument(safePath.join(root, SKILL), 'markdown');
        const built = await population.source.storedDocument(safePath.join(root, 'dist', 'built.md'), 'markdown');
        await population.source.enumerate(root, outputs, 'refuse', members);
        return { skill, built, homePopulations: store.current.readExtentCalls - readsBefore };
      });
      expect(warm.skill?.facts.skillText).toStrictEqual(expected);
      expect(warm.built).toBeUndefined();
      expect(warm.homePopulations, 'one home population per run, whichever asks first').toBe(1);
    });

    it('answers nothing for a home git will not list, which reaches the ask as git\'s own no-answer', async () => {
      // The real case the narrowed catch exists for, as `vat audit <bundle>` meets it: a built
      // bundle under a gitignored `dist/` of a committed repository, whose untracked listing git
      // will not give for a home inside ignored territory.
      await plant('.gitignore', 'dist/\n');
      runGitOrThrow(['add', '-A'], { cwd: root });
      runGitOrThrow(['commit', '-q', '-m', 'ignore dist'], { cwd: root });
      const home = safePath.join(root, 'dist', 'skills', 'demo');
      await plant('dist/skills/demo/SKILL.md', SKILL_TEXT);
      const refusal = await new GitCrawlSource(home, []).enumerate().then(() => undefined, (error: unknown) => error);
      expect(refusal, 'premise: git gives no answer for that home, unwrapped').toMatchObject({ code: GIT_NO_ANSWER_CODE });
      const document = await withRun(true, { home }, (population) =>
        population.source.storedDocument(safePath.join(home, 'SKILL.md'), 'markdown'));
      expect(document).toBeUndefined();
    });

    it('answers nothing for a member that cannot be read now', async () => {
      await runOnce(true);
      const between = (): Promise<void> => rm(safePath.join(root, SKILL));
      expect((await documentOf(true, SKILL, { between })).document).toBeUndefined();
    });
  });

  describe('a case that only reads the tree shares one copy, and starts from its own copy of one store', () => {
    // Only the store is copied per case: a case that writes or evicts changes its own copy. The
    // tree, which no case here changes, is one copy for all of them, since a store answers for
    // one root.

    /** The store one cold run of the shared tree filed. */
    let warmStore = new FakeFactStore();
    /** {@link SKILL}'s content key, as that cold run admitted it. */
    let skillKey = '';

    beforeAll(async () => {
      root = await copyOfRepo(committedWithSkill);
      store.current = new FakeFactStore();
      const cold = await runOnce(true);
      expect(cold.outcome).toBe('written');
      const skill = cold.resources.find((resource) => resource.filePath === safePath.join(root, SKILL));
      if (skill === undefined) throw new Error(`the cold run admitted no ${SKILL}`);
      skillKey = skill.contentKey;
      warmStore = store.current;
    });

    afterAll(removeRoot);

    beforeEach(() => {
      store.current = warmStore.copy();
    });

    it.each([
      ['after the run enumerated the home', {}],
      ['asked before anything enumerated the home: the ask opens it', { first: true }],
    ] as const)('answers a warm member from the blob tier, with no read, hash or parse, %s', async (_when, ask) => {
      expect(expected.matches.length, 'the document must exercise the match rows').toBeGreaterThan(1);
      const warm = await documentOf(true, SKILL, ask);
      expect(warm.document?.facts.skillText).toStrictEqual(expected);
      expect(warm.work).toEqual({ reads: 0, hashed: 0, parseLookups: 0, admitted: 0 });
    });

    const denied = new Error('EACCES: permission denied, mkdir');
    it.each([
      ['git giving no answer for the root', { homeFault: new VatError(GIT_NO_ANSWER_CODE, 'git did not answer for the root') }],
      ['a store the question cannot open now', { storeFault: denied, questionStoreFault: new StoreQuestionUnavailableError(denied) }],
    ] as const)('answers nothing when the home it opens fails (%s), counted, and the verb\'s own enumeration still refuses', async (_case, variation) => {
      const fault = 'homeFault' in variation ? variation.homeFault : variation.storeFault;
      const unopenedBefore = readWorkCounters()['skillText.storeUnopened'];
      const answered = await withRun(true, variation, async (population) => {
        const first = await population.source.storedDocument(safePath.join(root, SKILL), 'markdown');
        const again = await population.source.storedDocument(safePath.join(root, 'docs', 'guide.md'), 'markdown');
        const enumerated = await population.source.enumerate(root, [], 'refuse', { include: INCLUDE, exclude: [], ignoredRefusals: 'record' })
          .then(() => undefined, (error: unknown) => error);
        return { first, again, enumerated };
      });
      expect(answered.first).toBeUndefined();
      expect(answered.again).toBeUndefined();
      expect(readWorkCounters()['skillText.storeUnopened'] - unopenedBefore, 'one failed opening per run').toBe(1);
      // The refusal stays on the enumeration the verb asked for: the same failure, as itself.
      expect(answered.enumerated).toBe(fault);
    });

    it.each([
      ['a plain failure of the population', { homeFault: new Error('the extent could not be read') }],
      ['a git failure of the environment\'s', { homeFault: new VatError(GIT_FAILED_CODE, 'git ran out of time') }],
      ['a store refusing for a reason the question does not expect', { storeFault: new Error('the backend is not installed') }],
    ] as const)('refuses on every other failure of the home it opens: %s', async (_case, variation) => {
      const fault = 'homeFault' in variation ? variation.homeFault : variation.storeFault;
      const unopenedBefore = readWorkCounters()['skillText.storeUnopened'];
      const asked = await withRun(true, variation, (population) =>
        population.source.storedDocument(safePath.join(root, SKILL), 'markdown').then(() => undefined, (error: unknown) => error));
      expect(asked).toBe(fault);
      expect(readWorkCounters()['skillText.storeUnopened'] - unopenedBefore, 'a defect is no failed opening').toBe(0);
    });

    it('never hands the verb a home population the question failed to write: it builds the home itself', async () => {
      // Cold: the question derives the home and meets the lock at its first write.
      fromEmptyStore();
      const fault = new StoreQuestionUnavailableError(new Error('database is locked'));
      const unopenedBefore = readWorkCounters()['skillText.storeUnopened'];
      const answered = await withRun(true, { questionWriteFault: fault }, async (population) => {
        const document = await population.source.storedDocument(safePath.join(root, SKILL), 'markdown');
        const enumerated = await population.source.enumerate(root, [], 'refuse', { include: INCLUDE, exclude: [], ignoredRefusals: 'record' });
        return { document, outcome: enumerated.outcome.stored };
      });
      expect(answered.document).toBeUndefined();
      expect(readWorkCounters()['skillText.storeUnopened'] - unopenedBefore, 'the question counted its failure').toBe(1);
      expect(answered.outcome, 'the verb built and filed the home through its own connection').toBe('written');
    });

    it('builds one home population when a verb\'s enumeration starts while the question is building it', async () => {
      const members = { include: INCLUDE, exclude: [], ignoredRefusals: 'record' } as const;
      const homePopulations = await withRun(true, {}, async (population) => {
        const readsBefore = store.current.readExtentCalls;
        // Neither awaited before the other starts: the verb meets the question's build in flight.
        await Promise.all([
          population.source.storedDocument(safePath.join(root, SKILL), 'markdown'),
          population.source.enumerate(root, [], 'refuse', members),
        ]);
        return store.current.readExtentCalls - readsBefore;
      });
      expect(homePopulations).toBe(1);
    });

    it('reads the question-built home\'s blob tier inside the question, so a connection that cannot answer refuses no later admission', async () => {
      const fault = new StoreQuestionUnavailableError(new Error('database is locked'));
      const unopenedBefore = readWorkCounters()['skillText.storeUnopened'];
      const answered = await withRun(true, { questionBlobReadFault: fault }, async (population) => {
        const document = await population.source.storedDocument(safePath.join(root, SKILL), 'markdown');
        // The verb's own crawl after the question: it admits from its own connection's read.
        const registry = ResourceRegistry.forRun(population, { baseDir: root, gitTracker: population.gitTracker });
        const crawl = await registry.crawl({ baseDir: root, include: INCLUDE, outputs: [], unreadable: 'refuse', ignoredRefusals: 'record', populationSource: population.source });
        return { document, outcome: crawl.population.outcome.stored, admitted: registry.getAllResources().length };
      });
      expect(answered.document).toBeUndefined();
      expect(readWorkCounters()['skillText.storeUnopened'] - unopenedBefore, 'the question counted its failure').toBe(1);
      expect(answered.outcome).toBe('hit');
      expect(answered.admitted).toBeGreaterThan(0);
    });

    it('answers nothing asked first on a store-off run, reading nothing to say so', async () => {
      const off = await documentOf(false, SKILL, { first: true });
      expect(off.document).toBeUndefined();
      expect(off.work).toEqual({ reads: 0, hashed: 0, parseLookups: 0, admitted: 0 });
    });

    it('answers nothing from the run\'s own admission: a cold store-on run and a store-off run both miss', async () => {
      // Every file the store does not serve is a counted miss, whatever a registry
      // in the same run admitted: an admission is a cold parse, not a store hit.
      fromEmptyStore();
      expect((await documentOf(true, SKILL, { admit: true })).document).toBeUndefined();
      expect((await documentOf(false, SKILL, { admit: true })).document).toBeUndefined();
    });

    it('answers a warm member a registry admitted from the store, sharing the admission\'s one probe', async () => {
      const warm = await documentOf(true, SKILL, { admit: true });
      expect(warm.document?.facts.skillText).toStrictEqual(expected);
      expect(warm.askProbes, 'the admission already probed the path').toBe(0);
    });

    it('answers nothing for an evicted key a registry then admitted by a cold parse', async () => {
      store.current.forgetBlobFacts(skillKey);
      const warm = await documentOf(true, SKILL, { admit: true });
      expect(warm.work.reads, 'the evicted key was admitted by a cold read').toBe(1);
      expect(warm.document).toBeUndefined();
    });

    it('answers nothing on a store-off run that admitted nothing', async () => {
      expect((await documentOf(false, SKILL)).document).toBeUndefined();
    });

    it('answers nothing on a store miss that admitted nothing: the population was derived, not served', async () => {
      fromEmptyStore();
      expect((await documentOf(true, SKILL)).document).toBeUndefined();
    });

    it('answers nothing under a parser the stored realization does not route to', async () => {
      expect((await documentOf(true, SKILL, { parserKind: 'none' })).document).toBeUndefined();
    });

    it('answers nothing for a blob with no skill-text record', async () => {
      expect((await documentOf(true, 'docs/page.html', { parserKind: 'html' })).document).toBeUndefined();
    });

    it('answers nothing for a member whose key the tier no longer holds', async () => {
      store.current.forgetBlobFacts(skillKey);
      expect((await documentOf(true, SKILL)).document).toBeUndefined();
    });

    it('answers nothing when the run parses under other limits than the store\'s facts were filed under', async () => {
      const variation = { limits: { timeMs: POPULATION_PARSE_LIMITS.timeMs + 1 } };
      expect((await documentOf(true, SKILL, { variation })).document).toBeUndefined();
    });

    it('answers nothing for a path the population does not hold', async () => {
      expect((await documentOf(true, 'docs/absent.md')).document).toBeUndefined();
    });
  });
});

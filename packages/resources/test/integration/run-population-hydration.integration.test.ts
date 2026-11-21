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

import { chmod, mkdir, open, rm, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { GitTracker, gitTreeKey, runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { type WorkSpent, workSpentNow, workSpentSince } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ParseCache } from '../../src/parse-cache.js';
import { ParseDispatcher, type ParsePoolPolicy } from '../../src/parse-dispatcher.js';
import { isParseLimitError, isParserThrewError, reviveParserThrow } from '../../src/parse-limits.js';
import { POPULATION_PARSE_LIMITS, RunContentCache } from '../../src/projection/content-cache.js';
import type { PopulationCache } from '../../src/projection/merge.js';
import { RunPopulation } from '../../src/projection/run-population.js';
import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ProjectConfig } from '../../src/schemas/project-config.js';
import type { ResourceMetadata } from '../../src/schemas/resource-metadata.js';
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

let root = '';
const store = { current: new FakeFactStore() };

beforeEach(async () => {
  // Both lanes parse for real: the on-disk parse cache would serve a cold run what an earlier
  // build parsed, and count its hits as lookups a warm run must not make.
  vi.stubEnv('VAT_CACHE', '0');
  root = createCommittedRepo('vat-run-population-hydration-', { files: { ...TREE }, gitignore: '' });
  store.current = new FakeFactStore();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await chmod(root, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

/**
 * @param relative - A root-relative path
 * @param content - Its bytes
 */
async function plant(relative: string, content: string): Promise<void> {
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
  const population = new RunPopulation({
    root,
    gitTracker: new GitTracker(root),
    cacheOf: () => Promise.resolve(cache),
    collectionsFor: () => Promise.resolve(undefined),
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
    const registry = ResourceRegistry.forRun(population, { baseDir: root });
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
  it('is never filed as a per-file finding, whatever errno it carries', async () => {
    const failing = new FailingBlobStore();
    store.current = failing;
    await runOnce(true);
    failing.failBlobs = true;
    await expect(runOnce(true)).rejects.toMatchObject({ code: 'PROJECTION_STORE_READ_FAILED' });
  });
});

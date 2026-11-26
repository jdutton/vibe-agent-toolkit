/**
 * `vat validate`'s checks overlap gate asks, of every member of a store hit, whether warm
 * admission would serve it from the store (`storedComputeBy`, route-only: no facts built). Warm
 * admission (`RunPopulation.admit`) then serves it or computes it. On the same store the two must
 * never disagree: a gate that says "served" for a member admission computes would let the parent
 * write the store or the parse cache beside a running checks child, and one that says "computed"
 * for a member admission serves would keep the overlap from ever firing.
 *
 * Each case takes the same committed tree through a cold run (which files the store), then asks
 * both of every member in a warm run over the store as the case leaves it: untouched, a key with
 * no blob rows, and the ways a damaged blob is found (a section or AST reference row count that does
 * not add up, and a frontmatter value that does not decode). The tree carries the other answers: facts, a stated
 * parse refusal, a not-text blob, an oversize file refused by its size, a member under another
 * parser, and a file the store holds no realization for.
 *
 * A collection that declares a `mimeType` retypes a file: the gate routes it through a resolver it
 * builds from the config, as `vat validate` does, and the registry through its own, and the two
 * must still agree.
 */

import { open, rm, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContentKey } from '../../src/content-key.js';
import { ParseCache } from '../../src/parse-cache.js';
import { ParseDispatcher } from '../../src/parse-dispatcher.js';
import { reviveParserThrow } from '../../src/parse-limits.js';
import { POPULATION_PARSE_LIMITS, RunContentCache } from '../../src/projection/content-cache.js';
import type { PopulationCache } from '../../src/projection/merge.js';
import { parseRoutingFor, parserKindForResolvedPath } from '../../src/projection/router.js';
import { type AdmittedFacts, type HomeSettlement, RunPopulation } from '../../src/projection/run-population.js';
import type { BlobScopedRows, BlobScopedTableName, FactStore } from '../../src/projection/store.js';
import { storedComputeBy, type StoredContent } from '../../src/projection/stored-admission.js';
import { runStoredReads } from '../../src/projection/stored-reads.js';
import { ResourceRegistry } from '../../src/resource-registry.js';
import type { CollectionConfig, ProjectConfig } from '../../src/schemas/project-config.js';
import { FakeFactStore, noDatabaseFile, WIDE_BLOB_BUDGET_BYTES } from '../fake-fact-store.js';
import { failingParsePolicy } from '../helpers/failing-parse-policy.js';
import { createCommittedRepo } from '../test-helpers.js';

/** A document the injected parse pool fails, by this marker in its text: a stated refusal. */
const PARSE_FAILS = 'PARSE-FAILS-HERE';

const TREE: Readonly<Record<string, string>> = {
  'docs/a.md': '---\nid: a\n---\n# A\n\nSee [b](./b.md).\n',
  'docs/b.md': '# B\n\n## Two\n\nBack [a](./a.md).\n',
  'docs/fails.md': `# Fails\n\n${PARSE_FAILS}\n`,
  'docs/binary.md': 'bin\u0000ary\n',
  // Routed to no parser by its extension; the RETYPED collection makes it markdown.
  'notes/n.json': '# Note\n\nSee [a](../docs/a.md).\n',
};
const INCLUDE = ['**/*.md'];
/** Planted past the input cap after the commit: refused by its size, never read. */
const OVERSIZE = 'docs/big.md';
/** Planted after the cold run: the store holds no realization for it. */
const LATE = 'docs/late.md';
/** The file {@link RETYPED} retypes. */
const NOTE = 'notes/n.json';
/** A collection whose declared `mimeType` overrides the extension table for {@link NOTE}. */
const RETYPED: Readonly<Record<string, CollectionConfig>> = { notes: { include: ['notes/*.json'], mimeType: 'text/markdown' } };

let root = '';
let store = new FakeFactStore(WIDE_BLOB_BUDGET_BYTES);

beforeEach(async () => {
  // A real parse in both lanes: the on-disk parse cache would serve what an earlier build parsed.
  vi.stubEnv('VAT_CACHE', '0');
  root = createCommittedRepo('vat-stored-gate-agreement-', { files: { ...TREE }, gitignore: '' });
  store = new FakeFactStore(WIDE_BLOB_BUDGET_BYTES);
  const handle = await open(safePath.join(root, OVERSIZE), 'w');
  try {
    await handle.truncate(POPULATION_PARSE_LIMITS.inputBytes + 1);
  } finally {
    await handle.close();
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/** One question: a file, under a parser. */
interface Ask {
  readonly path: string;
  readonly parserKind: string;
}

/** Both answers to one {@link Ask}: whether each says the store serves it. */
interface Answers {
  readonly ask: string;
  readonly gate: boolean;
  readonly admission: boolean;
}

/** What a run's cold lane returns when admission computes: never inspected. */
const COMPUTED: AdmittedFacts = { kind: 'not-admitted', entry: { log: 'unreadable', entry: { reason: 'computed', code: 'COMPUTED' } } };

/**
 * One run over `view`: the home enumerated (a derive, or a hit), and its settlement handed back.
 *
 * @param view - The store the run reads
 * @param collections - The root's `resources.collections`
 * @param work - What to do once the home settled, given the run and the hit's stored content
 * @returns What `work` returns
 */
async function inRun<T>(
  view: FactStore,
  collections: Readonly<Record<string, CollectionConfig>> | undefined,
  work: (population: RunPopulation, stored: StoredContent | null) => Promise<T>,
): Promise<T> {
  const cache: PopulationCache = { store: view, treeHash: 'agreement-suite', treeUnchanged: () => true };
  const failure = reviveParserThrow({ name: 'TypeError', message: 'bad input', code: 'ERR_INVALID_ARG_TYPE' }, true);
  const content = new RunContentCache();
  const policy = { content, ...failingParsePolicy((text) => (text.includes(PARSE_FAILS) ? failure : undefined)) };
  const dispatcher = new ParseDispatcher(new ParseCache({ enabled: false }), policy);
  let settled: HomeSettlement | undefined;
  const population = new RunPopulation({
    root,
    outputs: [],
    gitTracker: new GitTracker(root),
    cacheOf: () => Promise.resolve(cache),
    questionCacheOf: () => Promise.resolve(cache),
    holdsStore: true,
    collectionsFor: () => Promise.resolve(collections),
    onHomeSettled: (_key, settlement) => {
      settled = settlement;
    },
  }, { content, dispatcher, stored: runStoredReads() });
  try {
    await population.source.enumerate(root, [], 'refuse', { include: INCLUDE, exclude: [], ignoredRefusals: 'record' });
    await new Promise((resolve) => { setImmediate(resolve); });
    if (settled?.ok !== true) throw new Error('the home did not settle');
    return await work(population, settled.enumeration.stored);
  } finally {
    await dispatcher.shutdown();
  }
}

/**
 * The cold run: the store misses, so the run derives and files the population.
 *
 * @param collections - The root's `resources.collections`
 */
async function fileTheStore(collections: Readonly<Record<string, CollectionConfig>> | undefined = undefined): Promise<void> {
  await inRun(store, collections, async (_population, stored) => {
    expect(stored, 'the cold run carries its own projection\'s rows').not.toBeNull();
  });
  await writeFile(safePath.join(root, LATE), '# Late\n');
}

/**
 * Ask the gate's check and admission the same questions in one warm run over `view`.
 *
 * @param view - The store as the case leaves it
 * @returns Every ask with both answers, and the hit's content keys by root-relative path
 */
async function bothAnswers(view: FactStore): Promise<{ answers: Answers[]; keys: ReadonlyMap<string, ContentKey> }> {
  return inRun(view, undefined, async (population, stored) => {
    if (stored === null) throw new Error('the warm run did not hit');
    // The gate's routing from the constructor `vat validate`'s `gateOptionsFor` calls (that lives in
    // the cli, which this package cannot import): `parseRoutingFor`, with no config here.
    const routing = parseRoutingFor(undefined, population.root);
    const relative = (path: string): string => safePath.relative(root, path);
    const asks: Ask[] = [...stored.members.keys(), safePath.join(root, LATE)].map((path) => ({
      path,
      parserKind: parserKindForResolvedPath(path, routing.resolver, routing.baseDir),
    }));
    // A member asked under another parser than the one its key names.
    asks.push({ path: safePath.join(root, 'docs/a.md'), parserKind: 'none' });
    const answers: Answers[] = [];
    for (const ask of asks) {
      const gate = (await storedComputeBy(stored.members.get(ask.path), ask.parserKind, stored.facts)).computeBy === null;
      let computed = false;
      await population.admit(ask.path, ask.parserKind, () => {
        computed = true;
        return Promise.resolve(COMPUTED);
      });
      answers.push({ ask: `${relative(ask.path)} as ${ask.parserKind}`, gate, admission: !computed });
    }
    const keys = new Map<string, ContentKey>();
    for (const [path, realization] of stored.members) {
      if (realization.contentKey !== null) keys.set(relative(path), realization.contentKey);
    }
    return { answers, keys };
  });
}

/** The blob tables a case damages. */
const DAMAGEABLE_TABLES = ['blobs', 'blobReferences', 'blobSections'] as const satisfies readonly BlobScopedTableName[];
type DamageableRows = Pick<BlobScopedRows, (typeof DAMAGEABLE_TABLES)[number]>;

/**
 * The store as `transform` leaves each blob read.
 *
 * @param transform - What happens to the rows a read returns
 * @returns A view over the suite's store
 */
function viewOf(transform: (rows: DamageableRows) => DamageableRows): FactStore {
  return {
    async readBlobFacts(keys, request) {
      const rows = await store.readBlobFacts(keys, request);
      // Every read here is the stored admission's, whose request names every table a case damages.
      const requested = new Set<string>(request.tables);
      const missing = DAMAGEABLE_TABLES.find((table) => !requested.has(table));
      if (missing !== undefined) throw new Error(`the view damages ${missing}, which this read did not request`);
      return { ...rows, ...transform(rows as unknown as DamageableRows) };
    },
    writeBlobFacts: (write) => store.writeBlobFacts(write),
    readExtent: (key, request) => store.readExtent(key, request),
    writeExtent: (key, rows) => store.writeExtent(key, rows),
    close: () => store.close(),
    attachedTo: noDatabaseFile,
  };
}

/** The key `path` was filed under, which the fixture must have keyed. */
function keyAt(keys: ReadonlyMap<string, ContentKey>, path: string): ContentKey {
  const key = keys.get(path);
  if (key === undefined) throw new Error(`no key for ${path}`);
  return key;
}

/** The served flag of each ask, by the gate's answer: the agreement already asserted. */
function served(answers: readonly Answers[]): Record<string, boolean> {
  for (const { ask, gate, admission } of answers) expect({ ask, gate }, 'the gate agrees with admission').toEqual({ ask, gate: admission });
  return Object.fromEntries(answers.map(({ ask, gate }) => [ask, gate]));
}

/** What every ask comes to on the untouched store. */
const UNTOUCHED = {
  // The repository's own `.gitignore`: a member, keyed under the parser nothing runs.
  '.gitignore as none': true,
  'docs/a.md as markdown': true,
  'docs/b.md as markdown': true,
  'docs/fails.md as markdown': true,
  'docs/binary.md as markdown': true,
  [`${NOTE} as none`]: true,
  [`${OVERSIZE} as markdown`]: true,
  [`${LATE} as markdown`]: false,
  'docs/a.md as none': false,
};

describe('the gate\'s member check and warm admission agree on the same store', () => {
  it('untouched: facts, a stated refusal, not-text and oversize served; absent and another parser computed', async () => {
    await fileTheStore();
    const { answers } = await bothAnswers(store);
    expect(served(answers)).toEqual(UNTOUCHED);
  });

  it('a key with no blob rows: computed by both', async () => {
    await fileTheStore();
    const { keys } = await bothAnswers(store);
    const evicted = keyAt(keys, 'docs/b.md');
    store.forgetBlobFacts(evicted);
    expect(served((await bothAnswers(store)).answers)).toEqual({ ...UNTOUCHED, 'docs/b.md as markdown': false });
  });

  it('a damaged blob, its section rows short of headingCount: computed by both', async () => {
    await fileTheStore();
    const { keys } = await bothAnswers(store);
    const damaged = keyAt(keys, 'docs/b.md');
    const view = viewOf((rows) => ({ ...rows, blobSections: rows.blobSections.filter((row) => row.blob !== damaged) }));
    expect(served((await bothAnswers(view)).answers)).toEqual({ ...UNTOUCHED, 'docs/b.md as markdown': false });
  });

  it('a damaged blob, an AST reference row missing against linkCount: computed by both', async () => {
    await fileTheStore();
    const { keys } = await bothAnswers(store);
    const damaged = keyAt(keys, 'docs/a.md');
    const view = viewOf((rows) => {
      const dropped = rows.blobReferences.find((row) => row.blob === damaged && row.astIndex !== null);
      if (dropped === undefined) throw new Error('docs/a.md filed no AST reference row');
      return { ...rows, blobReferences: rows.blobReferences.filter((row) => row !== dropped) };
    });
    expect(served((await bothAnswers(view)).answers)).toEqual({ ...UNTOUCHED, 'docs/a.md as markdown': false });
  });

  it('a damaged blob, its frontmatter value not decoding: computed by both', async () => {
    await fileTheStore();
    const { keys } = await bothAnswers(store);
    const damaged = keyAt(keys, 'docs/a.md');
    const view = viewOf((rows) => ({
      ...rows,
      blobs: rows.blobs.map((row) => (row.contentKey === damaged ? { ...row, frontmatterValue: 'not the codec encoding' } : row)),
    }));
    expect(served((await bothAnswers(view)).answers)).toEqual({ ...UNTOUCHED, 'docs/a.md as markdown': false });
  });
});

describe('a collection whose mimeType retypes a member', () => {
  it('is routed alike by the gate and the registry, each from the config, and served by both', async () => {
    const config: ProjectConfig = { resources: { collections: RETYPED } };
    await fileTheStore(RETYPED);
    const note = safePath.join(root, NOTE);
    const seen = await inRun(store, RETYPED, async (population, stored) => {
      if (stored === null) throw new Error('the warm run did not hit');
      // The gate's routing, as `vat validate` builds it (`parseRoutingFor`) over the same config.
      const routing = parseRoutingFor(config, population.root);
      const gateKind = parserKindForResolvedPath(note, routing.resolver, routing.baseDir);
      const gate = (await storedComputeBy(stored.members.get(note), gateKind, stored.facts)).computeBy === null;
      // Admission's routing: the registry's own resolver over the same config, observed at `admit`.
      const registryKinds: string[] = [];
      let computed = false;
      const admit = population.admit.bind(population);
      vi.spyOn(population, 'admit').mockImplementation((absolutePath, parserKind, compute) => {
        registryKinds.push(parserKind);
        return admit(absolutePath, parserKind, () => {
          computed = true;
          return compute();
        });
      });
      await ResourceRegistry.forRun(population, { baseDir: root, config, gitTracker: population.gitTracker }).addResource(note);
      return { gateKind, registryKinds, gate, admission: !computed };
    });

    const unconfigured = parseRoutingFor(undefined, root);
    expect(parserKindForResolvedPath(note, unconfigured.resolver, unconfigured.baseDir), 'the override changes the kind').toBe('none');
    expect(seen).toEqual({ gateKind: 'markdown', registryKinds: ['markdown'], gate: true, admission: true });
  });
});

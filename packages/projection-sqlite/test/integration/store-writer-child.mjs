/**
 * One writer process, for the cross-process arms of the store integration test.
 *
 * A separate **process**, not a worker thread, on purpose: POSIX advisory locks
 * are held per process, and SQLite arbitrates two connections inside one process
 * through its own machinery rather than through the file locks a second process
 * would take. A thread-based harness would exercise a different code path and
 * report a pass that says nothing about the claim being tested.
 *
 * Imports the built packages rather than the source, because this runs under
 * plain `node` with no TypeScript loader — which is why the package's own
 * `build` is a dependency of `test:integration` (see `turbo.json`).
 *
 * Usage: node store-writer-child.mjs <directory> <writerId> <mode> <iterations> [retention]
 *   mode `distinct`  — write `iterations` blobs and one extent, all this
 *                      writer's own, so the parent can count for loss
 *   mode `contended` — rewrite ONE shared extent `iterations` times, so a
 *                      concurrent reader can look for a torn read
 *
 * Usage: node store-writer-child.mjs <directory> <writerId> covering <blobTierBudgetBytes> <barrier> <peers> <keys>
 *   mode `covering`  — one run's blob write: read the tier for `keys` (comma
 *                      separated) and call each key with a `blobs` row covered,
 *                      wait until `peers` writers have read (a `<writerId>.ready`
 *                      file each under `barrier`), then write every key through
 *                      the port with that coverage
 *
 * Usage: node store-writer-child.mjs <directory> <writerId> covering-rowsets <rowSetTierBudgetBytes> <barrier> <peers> <coverable> <extracted>
 *   mode `covering-rowsets` — one run's row-set write: read the tier for the
 *                      contract row sets of `coverable` (comma-separated seeds),
 *                      call the present ones covered, wait for `peers` writers as
 *                      `covering` does, then write a covered one's head row and
 *                      every other row set whole, `extracted` included
 *
 * Usage: node store-writer-child.mjs <directory> <writerId> rowsets-until-killed <nodes>
 *   mode `rowsets-until-killed` — write row sets of `nodes` nodes each, four per
 *                      write, until the parent kills the process
 *
 * `retention` is `retainedExtentsPerRoot`, and it is a parameter because the
 * `distinct` arm writes one tree PER WRITER under a single root. That arm asks
 * whether a concurrent write LOSES rows — the failure that rejected `pglite`,
 * where four writers dropped 100–150 of 250 rows and every process exited 0 —
 * and eviction dropping the oldest tree on purpose is a different event with the
 * same shape from the outside. The parent hands a retention that admits every
 * writer so the arm keeps measuring contention rather than retention; the
 * retention policy itself is pinned in `test/store.test.ts`.
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { DEFAULT_BLOB_TIER_BUDGET_BYTES, DEFAULT_ROW_SET_TIER_BUDGET_BYTES, openSqliteFactStore } from '@vibe-agent-toolkit/projection-sqlite';
import { rowSetIdText } from '@vibe-agent-toolkit/resources';
import { contractRowSet, contractRowSetId, testContentKey } from '@vibe-agent-toolkit/resources/testing';
import { forEachInOrder, safePath } from '@vibe-agent-toolkit/utils';

const [directory, writerId, mode, iterationsRaw, retentionRaw] = process.argv.slice(2);
const iterations = Number(iterationsRaw);

/** How long a `covering` writer waits for its peers before giving up. */
const BARRIER_DEADLINE_MS = 15_000;

/** This writer's `index`th content key; the parent derives the same keys to count them. */
function key(writer, index) {
  return testContentKey('markdown', `${writer}${index}`);
}

/** One key's rows: a `blobs` row and one `claude-code` harness pair; the other blob tables stay empty. */
function blobBundle(contentKey) {
  return {
    blobs: [{
      contentKey,
      bytes: 1,
      encoding: 'utf-8',
      encodingSource: 'assumed',
      replacementCharacters: 0,
      tokenEstimate: 1,
      frontmatter: null,
      frontmatterValue: null,
      frontmatterError: null,
      frontmatterNotAMapping: false,
      anchors: [],
      wordCount: 1,
      proseCodeUnits: 1,
      codeBlockCodeUnits: 0,
      linkCount: 0,
      headingCount: 0,
      sectionCount: 0,
      findingCount: 0,
    }],
    blobReferences: [],
    blobSections: [],
    blobConditions: [],
    harnessBlobFacts: [{ blob: contentKey, harness: 'claude-code', injectedBytes: 1, injectedTokens: 1, paths: null }],
    harnessBlobImports: [],
  };
}

/**
 * An extent whose two tables always carry the SAME number of rows.
 *
 * That equality is what a torn read breaks: a reader seeing one table replaced
 * and the other not observes a count mismatch, which no committed state can
 * produce.
 */
function extentBundle(rootId, count) {
  return {
    roots: Array.from({ length: count }, (_, index) => ({ id: `${rootId}-${index}`, path: `/corpus/${index}` })),
    resources: [],
    resourceRealizations: [],
    resourceExtents: [],
    resourceTags: [],
    realizationConditions: [],
    resolutionContexts: [],
    zoneProvenance: Array.from({ length: count }, (_, index) => ({
      contextId: `ctx-${index}`,
      contributorId: `contributor-${index}`,
      parameterSet: null,
      extentDigest: `digest-${index}`,
    })),
  };
}

/** The rows of several keys as one bundle. */
function mergedBundle(contentKeys) {
  const merged = {};
  for (const contentKey of contentKeys) {
    for (const [table, rows] of Object.entries(blobBundle(contentKey))) merged[table] = [...(merged[table] ?? []), ...rows];
  }
  return merged;
}

/** Wait until `peers` writers have each left a ready file under `barrier`. */
async function awaitPeers(barrier, peers, deadline = Date.now() + BARRIER_DEADLINE_MS) {
  if (readdirSync(barrier).filter((name) => name.endsWith('.ready')).length >= peers) return;
  if (Date.now() > deadline) throw new Error(`writer ${writerId}: the barrier never filled`);
  await sleep(2);
  await awaitPeers(barrier, peers, deadline);
}

/** One run's blob write against a store other writers share: read, decide coverage, barrier, write. */
async function coveringWrite() {
  const [, , , budget, barrier, peers, keysRaw] = process.argv.slice(2);
  const held = keysRaw.split(',');
  const store = openSqliteFactStore({ directory, blobTierBudgetBytes: Number(budget), rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES });
  try {
    const read = (await store.readBlobFacts(held, { tables: ['blobs'], referenceForms: 'all' })).rows;
    const covered = read.blobs.map((row) => row.contentKey);
    writeFileSync(safePath.join(barrier, `${writerId}.ready`), '');
    await awaitPeers(barrier, Number(peers));
    await store.writeBlobFacts({
      rows: mergedBundle(held),
      coveredAtRead: covered,
      settledAtRead: covered.map((contentKey) => ({ contentKey, harness: 'claude-code' })),
    });
  } finally {
    await store.close();
  }
}

/** Several row sets' rows as one bundle, table by table. */
function mergedRowSets(bundles) {
  const merged = { dataFiles: [], dataDocuments: [], dataNodes: [], dataConditions: [] };
  for (const bundle of bundles) {
    for (const [table, rows] of Object.entries(bundle)) merged[table].push(...rows);
  }
  return merged;
}

/**
 * One run's row-set write against a store other writers share: read the row sets it may serve,
 * call the present ones covered, barrier, then write the covered ones' head rows and the row sets
 * it extracted, whole.
 */
async function coveringRowSetWrite() {
  const [, , , budget, barrier, peers, coverableRaw, extractedRaw] = process.argv.slice(2);
  const coverable = coverableRaw.split(',').map((seed) => contractRowSetId(seed));
  const extracted = extractedRaw.split(',').map((seed) => contractRowSetId(seed));
  const store = openSqliteFactStore({ directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: Number(budget) });
  try {
    const { present } = await store.readRowSets(coverable, { tables: ['dataFiles'] });
    const covered = coverable.filter((id) => present.has(rowSetIdText(id)));
    const absent = coverable.filter((id) => !present.has(rowSetIdText(id)));
    writeFileSync(safePath.join(barrier, `${writerId}.ready`), '');
    await awaitPeers(barrier, Number(peers));
    await store.writeRowSets({
      rows: mergedRowSets([
        ...covered.map((id) => ({ ...contractRowSet(id), dataDocuments: [], dataNodes: [] })),
        ...[...absent, ...extracted].map((id) => contractRowSet(id)),
      ]),
      coveredAtRead: covered,
    });
  } finally {
    await store.close();
  }
}

/** One row set of `nodes` string nodes: the contract row set, its one node repeated by ordinal. */
function wideRowSet(id, nodes) {
  const base = contractRowSet(id);
  const [template] = base.dataNodes;
  return {
    ...base,
    dataFiles: base.dataFiles.map((row) => ({ ...row, nodeCount: nodes })),
    dataNodes: Array.from({ length: nodes }, (_, ordinal) => ({ ...template, ordinal })),
  };
}

/**
 * Write row sets, four per write, one write after another until the parent kills the process:
 * recursive rather than a loop, as {@link awaitPeers} is, so one transaction is in flight at a time.
 */
async function rowSetsUntilKilled(store = openSqliteFactStore({ directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES }), write = 0) {
  const ids = [0, 1, 2, 3].map((slot) => contractRowSetId(`kill-${writerId}-${write}-${slot}`));
  await store.writeRowSets({ rows: mergedRowSets(ids.map((id) => wideRowSet(id, Number(iterationsRaw)))), coveredAtRead: [] });
  await rowSetsUntilKilled(store, write + 1);
}

/** The `distinct` and `contended` arms: `iterations` writes, in order. */
async function repeatedWrites() {
  const store = openSqliteFactStore(
    retentionRaw === undefined
      ? { directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES }
      : { directory, retainedExtentsPerRoot: Number(retentionRaw), blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES, rowSetTierBudgetBytes: DEFAULT_ROW_SET_TIER_BUDGET_BYTES },
  );
  try {
    // In order: each write is one transaction, and the contention under test is between processes, not
    // between this writer's own writes — overlapping them would measure something else.
    const indexes = Array.from({ length: iterations }, (_, index) => index);
    if (mode === 'distinct') {
      await forEachInOrder(indexes, (index) =>
        store.writeBlobFacts({ rows: blobBundle(key(writerId, index)), coveredAtRead: [], settledAtRead: [] }),
      );
      await store.writeExtent({ rootId: 'root-shared', treeHash: `tree-${writerId}` }, extentBundle('r', 1));
    } else {
      // Alternate the row count so a stale half is detectable rather than
      // accidentally matching the fresh half.
      await forEachInOrder(indexes, (index) =>
        store.writeExtent({ rootId: 'root-shared', treeHash: 'tree-contended' }, extentBundle('r', (index % 3) + 1)),
      );
    }
  } finally {
    await store.close();
  }
}

if (mode === 'covering') await coveringWrite();
else if (mode === 'covering-rowsets') await coveringRowSetWrite();
else if (mode === 'rowsets-until-killed') await rowSetsUntilKilled();
else await repeatedWrites();

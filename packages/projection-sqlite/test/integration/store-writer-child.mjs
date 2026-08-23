/**
 * One writer process, for the cross-process arms of the store integration test.
 *
 * A separate **process**, not a worker thread, on purpose: POSIX advisory locks
 * are held per process, and SQLite arbitrates two connections inside one process
 * through its own machinery rather than through the file locks a second process
 * would take. A thread-based harness would exercise a different code path and
 * report a pass that says nothing about the claim being tested.
 *
 * Imports the built package rather than the source, because this runs under
 * plain `node` with no TypeScript loader — which is why the package's own
 * `build` is a dependency of `test:integration` (see `turbo.json`).
 *
 * Usage: node store-writer-child.mjs <directory> <writerId> <mode> <iterations> [retention]
 *   mode `distinct`  — write `iterations` blobs and one extent, all this
 *                      writer's own, so the parent can count for loss
 *   mode `contended` — rewrite ONE shared extent `iterations` times, so a
 *                      concurrent reader can look for a torn read
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

import { openSqliteProjectionStore } from '@vibe-agent-toolkit/projection-sqlite';

const [directory, writerId, mode, iterationsRaw, retentionRaw] = process.argv.slice(2);
const iterations = Number(iterationsRaw);

/** A content key of the shape the schema requires: `<parserKind>.<64 hex>`. */
function key(writer, index) {
  const seed = `${writer}${index}`;
  const digits = seed.padEnd(64, '0').slice(0, 64).replaceAll(/[^\da-f]/gu, '0');
  return `markdown.${digits}`;
}

/** The `blobs` row for one key; the three child tables stay empty here. */
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
      frontmatterError: null,
      wordCount: 1,
      proseCodeUnits: 1,
      codeBlockCodeUnits: 0,
      linkCount: 0,
      headingCount: 0,
      sectionCount: 0,
    }],
    blobReferences: [],
    blobSections: [],
    blobConditions: [],
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

const store = openSqliteProjectionStore(
  retentionRaw === undefined ? { directory } : { directory, retainedExtentsPerRoot: Number(retentionRaw) },
);
try {
  if (mode === 'distinct') {
    for (let index = 0; index < iterations; index += 1) {
      await store.writeBlobFacts(blobBundle(key(writerId, index)));
    }
    await store.writeExtent({ rootId: 'root-shared', treeHash: `tree-${writerId}` }, extentBundle('r', 1));
  } else {
    for (let index = 0; index < iterations; index += 1) {
      // Alternate the row count so a stale half is detectable rather than
      // accidentally matching the fresh half.
      await store.writeExtent(
        { rootId: 'root-shared', treeHash: 'tree-contended' },
        extentBundle('r', (index % 3) + 1),
      );
    }
  }
} finally {
  await store.close();
}

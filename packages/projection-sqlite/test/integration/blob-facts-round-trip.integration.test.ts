/**
 * The store-fidelity enforcer: for every fixture blob, the `ResourceMetadata` the
 * cold registry builds equals the one rebuilt from that blob's STORED facts by
 * the one fact reader (`blobFactsReader`), field by field over the mapping table
 * (`BLOB_FACT_FIELDS`).
 *
 * Through the real SQLite store, never an in-memory double: a double hands rows
 * back by reference, so a value JSON cannot carry (`-0`, `.inf`, a timestamp, a
 * set) survives it and the test could not fail on the encoding at all.
 *
 * Each fixture file seeds one fidelity case and is named for it, so a red names
 * the case. A warm/cold differential cannot stand in for this test before warm
 * validate reads blob facts: nothing would read the facts it compares.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { openSqliteFactStore } from '@vibe-agent-toolkit/projection-sqlite';
import {
  BLOB_FACT_FIELDS,
  blobFactsReader,
  buildResourceProjection,
  type BlobFactsOutcome,
  type FactStore,
  type ResourceLink,
  type ResourceMetadata,
  ResourceRegistry,
  withPopulationRun,
  withRunPopulation,
} from '@vibe-agent-toolkit/resources';
import { compareCodeUnits, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** One fixture file per fidelity case; the name is the case. */
const FIXTURE: Readonly<Record<string, string | Buffer>> = {
  'baseline.md': '---\ntitle: Baseline\n---\n# Baseline\n\nSee [the guide](./f5-parser-order.md#usage).\n',
  // F1: values JSON cannot carry. `!!timestamp` and `!!set` are explicit tags: the core schema decodes neither untagged.
  'f1-frontmatter-codec.md': '---\ninf: .inf\nnegzero: -0\nwhen: !!timestamp 2024-01-02T03:04:05Z\ntags: !!set { a, b }\n---\n# F1\n',
  // F2: valid YAML that is not a mapping: no frontmatter, no frontmatterError.
  'f2-not-a-mapping.md': '---\n- a\n- b\n---\n# F2\n',
  // F3: an inline HTML anchor is a fragment target.
  'f3-anchors.md': '# F3\n\n<a id="custom-anchor"></a>\n\nText.\n',
  // F4: a GFM autolink literal glued to text is rebuilt with no position at all.
  'f4-positionless-link.md': '# F4\n\nSee domain:www.anthropic.com for more.\n',
  // F5: the parser emits links, then references, then definitions; source order differs.
  'f5-parser-order.md': '[def]: ./baseline.md\n\n## Usage\n\nA [link](./baseline.md) and a [ref][def].\n',
  // F6: GitHub's slugger suffixes a repeat, and a title that already reads like a suffix collides.
  'f6-slugs.md': '# A\n\n## A\n\n## A 1\n',
  // F7: two dangling references with one label on one line are two findings.
  'f7-conditions.md': '# F7\n\nSee [one][missing] and [two][missing].\n',
  // F7: two identical HTML parse errors on one line, in document order.
  'f7-page.html': '<!DOCTYPE html><html><body><p id="top"></b></i> <a href="./baseline.md">Base</a></p></body></html>\n',
  // F8: a lexer-only form (`@`-prefixed) beside AST links: never a ResourceLink.
  'f8-forms.md': '# F8\n\nImport @docs/other.md here and [a link](./baseline.md).\n',
  // F14: bytes that are not text, under a name the markdown parser is routed to.
  'f14-not-text.md': Buffer.from([0x23, 0x20, 0x00, 0x01, 0x02, 0x5b, 0x78, 0x5d, 0x28, 0x79, 0x29, 0x0a]),
};

let root: string;
let storeDirectory: string;
let cold: Map<string, ResourceMetadata>;
let read: (relativePath: string) => BlobFactsOutcome;

beforeAll(async () => {
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-blob-round-trip-'));
  storeDirectory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-blob-round-trip-store-'));
  for (const [name, content] of Object.entries(FIXTURE)) writeFileSync(safePath.join(root, name), content);

  // The projection lane: derive every blob and file its facts in the store.
  const writer = openSqliteFactStore({ directory: storeDirectory });
  const keyOf = new Map<string, string>();
  try {
    const { projection } = await withPopulationRun((run) => buildResourceProjection({
      root,
      run,
      cache: { store: writer, treeHash: 'blob-round-trip', treeUnchanged: () => true },
    }));
    for (const row of projection.resourceRealizations) {
      if (row.contentKey !== null) keyOf.set(row.path, row.contentKey);
    }
  } finally {
    await writer.close();
  }

  // A second connection, so every fact comes back through SQLite rather than a handle's memory.
  const reader: FactStore = openSqliteFactStore({ directory: storeDirectory });
  try {
    const facts = blobFactsReader(await reader.readBlobFacts([...new Set(keyOf.values())]));
    read = (relativePath) => {
      const key = keyOf.get(relativePath);
      if (key === undefined) throw new Error(`the projection keyed no realization at ${relativePath}`);
      return facts(key);
    };
  } finally {
    await reader.close();
  }

  // The cold lane: the registry, crawled through a run with no store.
  cold = await withRunPopulation(
    {
      root,
      gitTracker: new GitTracker(root),
      cacheOf: () => Promise.resolve(undefined),
      collectionsFor: () => Promise.resolve(undefined),
    },
    async (population) => {
      const registry = new ResourceRegistry({ baseDir: root });
      await registry.crawl({
        baseDir: root,
        include: ['**/*.md', '**/*.html'],
        outputs: [],
        unreadable: 'refuse',
        ignoredRefusals: 'record',
        populationSource: population.source,
      });
      return new Map(registry.getAllResources().map((resource) => [safePath.relative(root, resource.filePath), resource]));
    },
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(storeDirectory, { recursive: true, force: true });
});

/**
 * A link's blob-fact fields: its resolution is live, never stored.
 *
 * @param link - A cold link
 * @returns Its shape
 */
function linkShape(link: ResourceLink): Omit<ResourceLink, 'resolvedPath' | 'anchorTarget' | 'resolvedId'> {
  const shape = { ...link };
  delete shape.resolvedPath;
  delete shape.anchorTarget;
  delete shape.resolvedId;
  return shape;
}

/**
 * The blob-fact fields of a cold resource, each present exactly as the cold lane left it.
 *
 * @param resource - The cold registry's resource
 * @returns One entry per blob-fact field
 */
function coldFacts(resource: ResourceMetadata): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const field of BLOB_FACT_FIELDS) {
    if (!Object.hasOwn(resource, field)) continue;
    facts[field] = field === 'links' ? resource.links.map((link) => linkShape(link)) : resource[field];
  }
  return facts;
}

describe('blob facts round trip: cold registry === one fact reader over the stored rows', () => {
  it('the fixture exercises every case: one cold resource per fixture file', () => {
    expect([...cold.keys()].sort(compareCodeUnits)).toEqual(Object.keys(FIXTURE).sort(compareCodeUnits));
  });

  it.each(Object.keys(FIXTURE))('%s', (name) => {
    const resource = cold.get(name);
    expect(resource, `cold registry admitted ${name}`).toBeDefined();
    const outcome = read(name);
    expect(outcome.kind, `${name}: ${outcome.kind === 'uncovered' ? outcome.reason : outcome.kind}`).toBe('facts');
    if (outcome.kind !== 'facts' || resource === undefined) return;
    const expected = coldFacts(resource);
    const rebuilt = outcome.facts as unknown as Record<string, unknown>;
    for (const field of BLOB_FACT_FIELDS) {
      expect(Object.hasOwn(rebuilt, field), `${name}.${field} presence`).toBe(Object.hasOwn(expected, field));
      expect(rebuilt[field], `${name}.${field}`).toStrictEqual(expected[field]);
    }
  });
});

/**
 * The store-fidelity enforcer: for every fixture blob, the `ResourceMetadata` the
 * cold registry builds equals the one rebuilt from that blob's STORED facts by
 * the one fact reader (`blobFactsReader`), field by field over the mapping table
 * (`BLOB_FACT_FIELDS`), each link's fields over `RESOURCE_LINK_FACT_SOURCES`.
 *
 * Warm `vat validate` builds its resources registry from exactly these rebuilt
 * facts on a store hit, so a case that fails here is a warm finding that differs
 * from the cold one (`warm-registry-hydration.integration.test.ts` holds the
 * registry itself warm against cold).
 *
 * Through the real SQLite store, never an in-memory double: a double hands rows
 * back by reference, so a value JSON cannot carry (`-0`, `.inf`, a timestamp, a
 * set) survives it and the test could not fail on the encoding at all.
 *
 * Each fixture file seeds one fidelity case, is named for it, and carries a
 * precondition asserting the case is really present in the cold resource or the
 * stored rows. Without one, a fixture that stopped producing its case (a parser
 * that started giving the autolink a position, a slugger that stopped
 * colliding) would still round-trip and the case would be untested while green.
 *
 * Two branches of the reader are held elsewhere, because no file's bytes reach
 * them: a parser THROW (`BLOB_PARSE_FAILED`, the not-admitted branch) is held
 * against the registry's own entry in `resources`'
 * `projection-blob-parse-failure-attribution.test.ts`, and a link with a line and
 * no offsets (parse5 no longer emits one) in `projection-blob-resource-facts.test.ts`.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';

import { openSqliteFactStore } from '@vibe-agent-toolkit/projection-sqlite';
import {
  BLOB_FACT_FIELDS,
  blobFactsReader,
  buildResourceProjection,
  flattenHeadings,
  RESOURCE_LINK_FACT_SOURCES,
  SKILL_TEXT_DECLARATION,
  skillTextFactsOf,
  type BlobFactsOutcome,
  type BlobScopedRows,
  type FactStore,
  type ResourceLink,
  type ResourceMetadata,
  ResourceRegistry,
  withPopulationRun,
  withRunPopulation,
} from '@vibe-agent-toolkit/resources';
import { compareCodeUnits, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { crawlWholeTree, teardownTreeSuite } from '../fixtures.js';

/** An SVG link through a namespaced attribute (F11). */
const XLINK_PAGE = '<!DOCTYPE html><svg><a xlink:href="./baseline.md">x</a></svg>\n';

/** What a precondition sees: the cold resource and the stored rows of its key. */
interface CaseEvidence {
  readonly resource: ResourceMetadata;
  readonly rows: BlobScopedRows;
}

/** One fidelity case: the file's bytes, and the assertion that the case is really in them. */
interface FidelityCase {
  readonly content: string | Buffer;
  readonly precondition: (evidence: CaseEvidence) => void;
}

/**
 * @param rows - One key's stored rows
 * @param code - A condition code
 * @returns The key's condition rows of that code
 */
function conditionsOf(rows: BlobScopedRows, code: string): BlobScopedRows['blobConditions'] {
  return rows.blobConditions.filter((row) => row.code === code);
}

/** One fixture file per fidelity case; the name is the case. */
const FIXTURE: Readonly<Record<string, FidelityCase>> = {
  // A skill-text match cut inside a surrogate pair: the imperative sample's 80th code unit is an
  // emoji's high surrogate, which SQLite's UTF-8 TEXT cannot hold on its own.
  'skill-text-split-sample.md': {
    content: `---\nname: s\n---\n# S\n\nYou should ${'a'.repeat(68)}\u{1F600} tail\n`,
    precondition: ({ rows }) => {
      expect(rows.skillTextMatches.some((row) => row.loneSurrogates !== null)).toBe(true);
    },
  },
  'baseline.md': {
    content: '---\ntitle: Baseline\n---\n# Baseline\n\nSee [the guide](./f5-parser-order.md#usage).\n',
    precondition: ({ resource }) => {
      expect(resource.frontmatter).toEqual({ title: 'Baseline' });
      expect(resource.links).toHaveLength(1);
    },
  },
  // F1: values JSON cannot carry. `!!timestamp` and `!!set` are explicit tags: the core schema decodes neither untagged.
  'f1-frontmatter-codec.md': {
    content: '---\ninf: .inf\nnegzero: -0\nwhen: !!timestamp 2024-01-02T03:04:05Z\ntags: !!set { a, b }\n---\n# F1\n',
    precondition: ({ resource, rows }) => {
      expect(resource.frontmatter?.['inf']).toBe(Number.POSITIVE_INFINITY);
      expect(Object.is(resource.frontmatter?.['negzero'], -0)).toBe(true);
      expect(resource.frontmatter?.['when']).toBeInstanceOf(Date);
      expect(resource.frontmatter?.['tags']).toBeInstanceOf(Set);
      // The JSON column is lossy, so only the codec column can carry the case.
      expect(rows.blobs[0]?.frontmatter?.['inf']).toBeNull();
    },
  },
  // F2: valid YAML that is not a mapping: no frontmatter, no frontmatterError.
  'f2-not-a-mapping.md': {
    content: '---\n- a\n- b\n---\n# F2\n',
    precondition: ({ resource, rows }) => {
      expect(rows.blobs[0]?.frontmatterNotAMapping).toBe(true);
      expect(Object.hasOwn(resource, 'frontmatter')).toBe(false);
      expect(Object.hasOwn(resource, 'frontmatterError')).toBe(false);
    },
  },
  // F3: an inline HTML anchor is a fragment target.
  'f3-anchors.md': {
    content: '# F3\n\n<a id="custom-anchor"></a>\n\nText.\n',
    precondition: ({ resource }) => {
      expect(resource.anchors).toContain('custom-anchor');
    },
  },
  // F4: a GFM autolink literal glued to text is rebuilt with no position at all.
  'f4-positionless-link.md': {
    content: '# F4\n\nSee domain:www.anthropic.com for more.\n',
    precondition: ({ resource }) => {
      expect(resource.links.length).toBeGreaterThan(0);
      expect(resource.links.some((link) => link.line === undefined && link.startOffset === undefined)).toBe(true);
    },
  },
  // F5: the parser emits links, then references, then definitions; source order differs.
  'f5-parser-order.md': {
    content: '[def]: ./baseline.md\n\n## Usage\n\nA [link](./baseline.md) and a [ref][def].\n',
    precondition: ({ rows }) => {
      const sourceOrder = rows.blobReferences
        .filter((row) => row.astIndex !== null)
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((row) => row.astIndex);
      expect(sourceOrder).toHaveLength(3);
      expect(sourceOrder).not.toEqual([0, 1, 2]);
    },
  },
  // F6: GitHub's slugger suffixes a repeat, and a title that already reads like a suffix collides.
  'f6-slugs.md': {
    content: '# A\n\n## A\n\n## A 1\n',
    precondition: ({ resource }) => {
      expect(flattenHeadings(resource.headings).map((heading) => heading.slug)).toEqual(['a', 'a-1', 'a-1-1']);
    },
  },
  // F7: two dangling references with one label on one line are two findings.
  'f7-conditions.md': {
    content: '# F7\n\nSee [one][missing] and [two][missing].\n',
    precondition: ({ rows }) => {
      const unresolved = conditionsOf(rows, 'UNRESOLVED_REFERENCE');
      expect(unresolved).toHaveLength(2);
      const [first, second] = unresolved;
      expect([second?.message, second?.line]).toEqual([first?.message, first?.line]);
    },
  },
  // F7: two identical HTML parse errors on one line, in document order. parse5
  // reports tokenizer errors only (a mis-nested end tag is none), so the case is
  // two duplicate attributes.
  'f7-page.html': {
    content: '<!DOCTYPE html><p id="a" id="b" class="c" class="d"><a href="./baseline.md">Base</a></p>\n',
    precondition: ({ resource, rows }) => {
      const errors = conditionsOf(rows, 'HTML_PARSE_ERROR');
      expect(errors.map((row) => [row.message, row.line])).toEqual([['duplicate-attribute', 1], ['duplicate-attribute', 1]]);
      expect(resource.links).toHaveLength(1);
    },
  },
  // F11: a namespaced `xlink:href`, the attribute whose span lookup once missed and
  // left a link with a line and no offsets. Its span is now the attribute's own.
  'f11-xlink.html': {
    content: XLINK_PAGE,
    precondition: ({ resource }) => {
      const [link] = resource.links;
      expect(resource.links).toHaveLength(1);
      expect(XLINK_PAGE.slice(link?.startOffset ?? 0, link?.endOffset ?? 0)).toBe('xlink:href="./baseline.md"');
    },
  },
  // F8: a lexer-only form (`@`-prefixed) beside AST links: never a ResourceLink.
  'f8-forms.md': {
    content: '# F8\n\nImport @docs/other.md here and [a link](./baseline.md).\n',
    precondition: ({ resource, rows }) => {
      expect(rows.blobReferences.some((row) => row.syntacticForm === 'at-prefixed')).toBe(true);
      expect(resource.links).toHaveLength(1);
    },
  },
  // F9: a frontmatter block that is not YAML: the parser's error, verbatim, and no frontmatter.
  'f9-frontmatter-error.md': {
    content: '---\npaths:\n  - **/x/*.ts\n---\n# F9\n',
    precondition: ({ resource, rows }) => {
      expect(resource.frontmatterError).toEqual(expect.any(String));
      expect(rows.blobs[0]?.frontmatterError).toBe(resource.frontmatterError);
      expect(Object.hasOwn(resource, 'frontmatter')).toBe(false);
    },
  },
  // F10: bytes no parser is routed to: a resource with no parse at all.
  'f10-no-parser.json': {
    content: '{ "see": "[a link](./baseline.md)" }\n',
    precondition: ({ resource, rows }) => {
      expect(rows.blobs).toHaveLength(1);
      const key = rows.blobs[0]?.contentKey ?? '';
      expect(['markdown.', 'html.'].some((parsed) => key.startsWith(parsed)), key).toBe(false);
      expect(resource.links).toEqual([]);
      expect(Object.hasOwn(resource, 'unresolvedReferences')).toBe(false);
    },
  },
  // F14: bytes that are not text, under a name the markdown parser is routed to.
  'f14-not-text.md': {
    content: Buffer.from([0x23, 0x20, 0x00, 0x01, 0x02, 0x5b, 0x78, 0x5d, 0x28, 0x79, 0x29, 0x0a]),
    precondition: ({ rows }) => {
      expect(rows.blobs).toEqual([]);
      expect(conditionsOf(rows, 'BLOB_NOT_TEXT')).toHaveLength(1);
    },
  },
};

let root: string;
let storeDirectory: string;
let cold: Map<string, ResourceMetadata>;
let read: (relativePath: string) => BlobFactsOutcome;
let storedOf: (relativePath: string) => BlobScopedRows;

/**
 * @param key - A content key
 * @param stored - Every stored row read back
 * @returns The rows of that key alone
 */
function rowsOfKey(key: string, stored: BlobScopedRows): BlobScopedRows {
  return {
    blobs: stored.blobs.filter((row) => row.contentKey === key),
    blobReferences: stored.blobReferences.filter((row) => row.blob === key),
    blobSections: stored.blobSections.filter((row) => row.blob === key),
    blobConditions: stored.blobConditions.filter((row) => row.blob === key),
    harnessBlobFacts: stored.harnessBlobFacts.filter((row) => row.blob === key),
    harnessBlobImports: stored.harnessBlobImports.filter((row) => row.blob === key),
    skillTextFacts: stored.skillTextFacts.filter((row) => row.blob === key),
    skillTextMatches: stored.skillTextMatches.filter((row) => row.blob === key),
  };
}

beforeAll(async () => {
  // Both lanes parse for real. The process-wide parse cache is on disk and a dev
  // checkout's namespace survives a rebuild, so with it on, the cold lane is served
  // whatever an earlier build parsed: a parser change would not reach this test.
  vi.stubEnv('VAT_CACHE', '0');
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-blob-round-trip-'));
  storeDirectory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-blob-round-trip-store-'));
  for (const [name, { content }] of Object.entries(FIXTURE)) writeFileSync(safePath.join(root, name), content);

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
    const stored = await reader.readBlobFacts([...new Set(keyOf.values())]);
    const facts = blobFactsReader(stored);
    const keyAt = (relativePath: string): string => {
      const key = keyOf.get(relativePath);
      if (key === undefined) throw new Error(`the projection keyed no realization at ${relativePath}`);
      return key;
    };
    read = (relativePath) => facts(keyAt(relativePath));
    storedOf = (relativePath) => rowsOfKey(keyAt(relativePath), stored);
  } finally {
    await reader.close();
  }

  // The cold lane: the registry, crawled through a run with no store.
  cold = await withRunPopulation(
    {
      root,
      outputs: [],
      gitTracker: new GitTracker(root),
      cacheOf: () => Promise.resolve(undefined),
      collectionsFor: () => Promise.resolve(undefined),
    },
    async (population) => {
      const registry = new ResourceRegistry({ baseDir: root });
      await crawlWholeTree(registry, root, population.source);
      return new Map(registry.getAllResources().map((resource) => [safePath.relative(root, resource.filePath), resource]));
    },
  );
});

afterAll(() => teardownTreeSuite(root, storeDirectory));

/**
 * A link's blob-fact fields, read off `RESOURCE_LINK_FACT_SOURCES` (its
 * resolution is live, never stored), in the order the cold link holds them.
 *
 * @param link - A cold link
 * @returns Its shape
 */
function linkShape(link: ResourceLink): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(link).filter(([field]) => RESOURCE_LINK_FACT_SOURCES[field as keyof ResourceLink] === 'blob-fact'),
  );
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

describe('skill-text round trip: the core\'s record over the text === the record read back through SQLite', () => {
  const markdown = Object.entries(FIXTURE).filter(([name, { content }]) => name.endsWith('.md') && typeof content === 'string');

  it.each(markdown)('%s', (name, { content }) => {
    const outcome = read(name);
    expect(outcome.kind === 'facts' && outcome.facts.skillText).toStrictEqual(skillTextFactsOf(content as string, SKILL_TEXT_DECLARATION));
  });
});

describe('blob facts round trip: cold registry === one fact reader over the stored rows', () => {
  it('the fixture exercises every case: one cold resource per fixture file', () => {
    expect([...cold.keys()].sort(compareCodeUnits)).toEqual(Object.keys(FIXTURE).sort(compareCodeUnits));
  });

  it.each(Object.keys(FIXTURE))('%s: the case is present', (name) => {
    const resource = cold.get(name);
    expect(resource, `cold registry admitted ${name}`).toBeDefined();
    if (resource === undefined) return;
    FIXTURE[name]?.precondition({ resource, rows: storedOf(name) });
  });

  it.each(Object.keys(FIXTURE))('%s: round-trips', (name) => {
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
    // One shape whichever lane built a link: the same keys in the same order.
    expect(outcome.facts.links.map((link) => Object.keys(link)), `${name}.links key order`)
      .toEqual((expected['links'] as Record<string, unknown>[] | undefined ?? []).map((link) => Object.keys(link)));
  });
});

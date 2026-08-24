/**
 * A broken INSTALL must not be reported as a corpus of broken RESOURCES.
 *
 * `indexResources` wraps each `indexResource` in a per-resource `try` for a real
 * reason: one document that cannot be read or chunked must not abandon a whole
 * indexing batch. The parse itself carries no local try — which is exactly why
 * this site was missed on a first pass. Its CALLER is the swallow: once the
 * markdown parser started arriving by `import()`, a `chmod 000` on the built
 * parser landed in that catch and produced one `result.errors` entry per
 * resource, `resourcesIndexed: 0`, and a resolved promise. The install was
 * broken and the report said every document was.
 *
 * ## Why the fix is a type and not a hoist, and not an inspection either
 *
 * Node's ESM loader reads the module through `fs`, so an unloadable parser
 * throws the same `EACCES` an unreadable *document* throws — nothing in the
 * error separates them, which is why a blocklist of loader codes was tried and
 * deleted.
 *
 * Awaiting `loadParser` above the loop was tried too, and is what this suite
 * used to drive. It works and it costs too much: the load happens inside
 * `parseFileCached`, past the parse cache's hit-path return, precisely so a
 * fully warm index loads no parser at all. Any hoist cancels that silently.
 *
 * So the load stays lazy and the catch rethrows one TYPE —
 * `ParserUnavailableError`, minted at VAT's single parser-import boundary and
 * matched by `isParserUnavailable`, complete by construction rather than by
 * enumeration. That the boundary really mints it is pinned in
 * `packages/resources/test/parser-unavailable-error.test.ts` against the real
 * `import()`; what this suite owns is who gets blamed here.
 *
 * ## Why both directions are pinned
 *
 * A suite that only proved propagation would pass equally against a loop that
 * rethrew everything — abandoning a batch on one bad document, the failure the
 * catch exists to prevent. The unreadable-document case below is that negative
 * control.
 *
 * LanceDB is mocked rather than driven: this suite is about who gets blamed for
 * a failed parse, and a real native table would add a second failure surface
 * (and a native module) to a unit test that has no use for either.
 */

import type { EmbeddingProvider, ResourceMetadata } from '@vibe-agent-toolkit/rag';
import type * as ResourcesModule from '@vibe-agent-toolkit/resources';
import { ParserUnavailableError } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanceDBRAGProvider } from '../src/lancedb-rag-provider.js';

import { createTestMarkdownFile, setupLanceDBTestSuite } from './test-helpers.js';

/**
 * What the next `parseFileCached` call throws, or nothing.
 *
 * `vi.hoisted` because the mock factory below is hoisted above every import and
 * would otherwise close over an uninitialised binding.
 */
const failures = vi.hoisted(() => ({ load: undefined as Error | undefined }));

// Only the parse seam is replaced, and only when armed. The real parser, the
// real `parseFileCached` and the real `isParserUnavailable` stay live via
// `importOriginal`, so the ordinary-failure case below fails for the reason a
// real unreadable document fails rather than because a stub said so, and the
// predicate under test is the shipped one.
vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => {
  const actual = await importOriginal<typeof ResourcesModule>();
  const parseFileCached = async (filePath: string, kind: ResourcesModule.ParserKind) =>
    failures.load ? Promise.reject(failures.load) : actual.parseFileCached(filePath, kind);
  return { ...actual, parseFileCached };
});

// A connection that accepts rows and forgets them. Nothing here asserts on what
// LanceDB stored — only on who the indexing loop blames.
vi.mock('@lancedb/lancedb', () => {
  const table = {
    add: async () => undefined,
    close: () => undefined,
    query: () => ({ where: () => ({ toArray: async () => [] }) }),
  };
  return {
    connect: async () => ({
      tableNames: async () => [],
      createTable: async () => table,
      openTable: async () => table,
      close: () => undefined,
    }),
  };
});

/**
 * Fixed-width vectors, so nothing in this suite loads an inference runtime.
 *
 * `maxInputTokens` is REQUIRED, not decoration: chunk sizing reads it, and a
 * provider that omits it fails every document with "leaves no room for
 * content" — which lands as an ordinary per-resource error and so reads here as
 * an extra unreadable document rather than as a broken stub. 256 matches the
 * local all-MiniLM-L6-v2 limit; any positive number would do, since this suite
 * asserts error ATTRIBUTION and never chunk boundaries.
 */
const STUB_EMBEDDINGS: EmbeddingProvider = {
  name: 'stub',
  model: 'stub-model',
  dimensions: 4,
  maxInputTokens: 256,
  embed: async () => [0, 0, 0, 1],
  embedBatch: async (texts: string[]) => texts.map(() => [0, 0, 0, 1]),
};

const suite = setupLanceDBTestSuite();

beforeEach(async () => {
  failures.load = undefined;
  await suite.beforeEach();
  suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, embeddingProvider: STUB_EMBEDDINGS });
});

afterEach(async () => {
  failures.load = undefined;
  await suite.afterEach();
});

/**
 * The failure the reproduction actually produced, as it arrives at the parse
 * site: `chmod 000` on the built parser, surfacing as the ESM loader's own `fs`
 * read failing, wrapped at VAT's import boundary.
 *
 * Built from the REAL exported class rather than hand-rolled, so a change to
 * what `isParserUnavailable` accepts cannot pass here by agreeing with a
 * fixture's idea of the type. The `EACCES` underneath is precisely the error an
 * inspection-based guard could never tell apart from an unreadable document.
 *
 * @returns A fresh error per test, so identity assertions are meaningful
 */
function parserLoadFailure(): Error {
  return new ParserUnavailableError(
    'markdown',
    './link-parser.js',
    Object.assign(new Error("permission denied, open '.../dist/link-parser.js'"), { code: 'EACCES' }),
  );
}

/**
 * Minimal resource metadata pointing at `filePath`.
 *
 * Hand-built rather than derived by parsing, because two of the three fixtures
 * below deliberately name a file that does not exist — deriving the metadata
 * would have to read it first.
 *
 * @param id - The resource id the error entry will be filed under
 * @param filePath - Absolute path the indexer will read and parse
 * @returns Metadata the indexing lane accepts
 */
function resourceAt(id: string, filePath: string): ResourceMetadata {
  return {
    id,
    filePath,
    links: [],
    headings: [],
    frontmatter: {},
    sizeBytes: 0,
    estimatedTokenCount: 0,
    modifiedAt: new Date(0),
    checksum: `${id}-checksum`,
  };
}

/**
 * Two resources naming files that were never written.
 *
 * Two, deliberately: the defect is "one entry per resource", so a single
 * resource could not tell an aborted batch apart from one recorded error.
 *
 * @returns The absent-file resources
 */
function missingResources(): ResourceMetadata[] {
  return [
    resourceAt('gone-1', safePath.join(suite.tempDir, 'gone-1.md')),
    resourceAt('gone-2', safePath.join(suite.tempDir, 'gone-2.md')),
  ];
}

/**
 * The provider under test, narrowed from the suite's nullable field.
 *
 * @returns The provider created in `beforeEach`
 */
function provider(): LanceDBRAGProvider {
  if (!suite.provider) throw new Error('provider was not created');
  return suite.provider;
}

describe('a parser-load failure during resource indexing', () => {
  it('propagates instead of blaming every resource in the batch', async () => {
    const thrown = parserLoadFailure();
    failures.load = thrown;
    const onProgress = vi.fn();

    // Identity, not `toThrow(message)`: what must survive is the loader's own
    // error object, because the caller's top-level handler prints its code.
    //
    // Under the defect this did not reject at all — it RESOLVED, carrying one
    // `errors` entry per resource and `resourcesIndexed: 0`.
    await expect(provider().indexResources(missingResources(), onProgress)).rejects.toBe(thrown);

    // Nothing was reported either: the rethrow leaves the first iteration before
    // its `onProgress`, so zero calls is the whole loop's silence. Under the
    // defect it fired once per resource and the run resolved.
    expect(onProgress).not.toHaveBeenCalled();
  });
});

/**
 * The discriminator. Without it, an `indexResources` that rethrew
 * unconditionally would satisfy every assertion above — and would abandon a
 * whole batch on one unreadable document, which the catch exists to prevent.
 */
describe('an ordinary read failure during resource indexing', () => {
  it('records one error per unreadable resource and finishes the batch', async () => {
    const resources = missingResources();

    const result = await provider().indexResources(resources);

    // Two entries, not one: the loop walked past the first failure.
    expect(result.errors).toHaveLength(resources.length);
    expect(result.errors?.map((entry) => entry.resourceId)).toEqual(resources.map((r) => r.id));
    expect(result.resourcesIndexed).toBe(0);
  });

  it('indexes the readable resources in a batch that also has an unreadable one', async () => {
    const readablePath = await createTestMarkdownFile(suite.tempDir, 'ok.md', '# Ok\n\nSome prose to chunk.\n');
    const resources = [
      resourceAt('gone-1', safePath.join(suite.tempDir, 'gone-1.md')),
      resourceAt('ok', readablePath),
    ];

    const result = await provider().indexResources(resources);

    // The baseline the counts above are read against: an unreadable neighbour
    // does not stop a healthy document from being indexed, so a zero elsewhere
    // is never just "this fixture indexes nothing".
    expect(result.errors).toHaveLength(1);
    expect(result.resourcesIndexed).toBe(1);
    expect(result.chunksCreated).toBeGreaterThan(0);
  });
});

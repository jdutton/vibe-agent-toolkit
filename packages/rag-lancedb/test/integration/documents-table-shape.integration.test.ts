/**
 * A `rag_documents` table written by an earlier build keeps working under this one.
 *
 * v0.1.42's document record carried only the frontmatter keys its own document
 * happened to have, so every documents table that release wrote lacks at least
 * `headingpath`, `headinglevel`, `startline` and `endline`, and usually `tags`
 * and `type` as well. This build writes every metadata column on every record,
 * and LanceDB refuses a record carrying a column the table does not have
 * ("Found field not in schema"). Left alone, that refusal landed AFTER the
 * `update` path had already deleted the changed resource's chunks and document
 * row — so a document an adopter edited vanished from the index and failed the
 * same way on every later run until the whole database was cleared.
 *
 * The table's shape is read and widened to the record's before anything is
 * deleted. No version number decides this: the table's own column list is
 * compared with the columns a record carries.
 *
 * Real LanceDB, on purpose: the refusal is LanceDB's own, and the old shape is
 * produced by v0.1.42's record writer, copied below verbatim so the fixture is
 * the shape that release actually wrote rather than a hand-typed column list.
 */

import * as lancedb from '@lancedb/lancedb';
import { ApproximateTokenCounter, DefaultRAGMetadataSchema, type TokenCounter } from '@vibe-agent-toolkit/rag';
import type { ResourceMetadata } from '@vibe-agent-toolkit/resources';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ZodObject, ZodRawShape } from 'zod';

import type { DocumentRecord } from '../../src/document-helpers.js';
import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import {
  createStubEmbeddingProvider,
  createTestMarkdownFile,
  createTestResource,
  setupLanceDBTestSuite,
} from '../test-helpers.js';

const DOCUMENTS_TABLE = 'rag_documents';

const suite = setupLanceDBTestSuite();
beforeEach(suite.beforeEach);
afterEach(suite.afterEach);

/**
 * `createDocumentRecord` exactly as v0.1.42 shipped it
 * (`git show v0.1.42:packages/rag-lancedb/src/document-helpers.ts`, lines 84-99):
 * core columns plus ONLY the frontmatter keys the document itself carried.
 *
 * @param resource - Resource metadata (id, filePath, frontmatter)
 * @param content - Transformed content to store
 * @param contentHash - Content hash for change detection
 * @param totalChunks - Number of chunks created from this document
 * @param tokenCounter - Token counter for computing token count
 * @param metadataSchema - Zod schema defining the metadata fields
 * @returns The record that release would have written
 */
function createDocumentRecordAtV0_1_42(
  resource: ResourceMetadata,
  content: string,
  contentHash: string,
  totalChunks: number,
  tokenCounter: TokenCounter,
  metadataSchema: ZodObject<ZodRawShape>,
): DocumentRecord {
  const documentRecord: DocumentRecord = {
    resourceid: resource.id,
    filepath: resource.filePath,
    content,
    contenthash: contentHash,
    tokencount: tokenCounter.count(content),
    totalchunks: totalChunks,
    indexedat: Date.now(),
  };

  if (resource.frontmatter) {
    for (const key of Object.keys(metadataSchema.shape)) {
      if (key in resource.frontmatter) {
        const value = resource.frontmatter[key];
        documentRecord[key.toLowerCase()] = typeof value === 'string' || typeof value === 'number'
          ? value
          : JSON.stringify(value);
      }
    }
  }

  return documentRecord;
}

/**
 * Rewrite the suite's documents table in the shape v0.1.42 wrote, keeping the
 * content, hash and chunk count this build recorded so change detection reads
 * the chunk rows and the document rows as one consistent index.
 *
 * @param resources - The resources whose rows the table holds, by id
 * @returns The column names the rewritten table has
 */
async function downgradeDocumentsTable(resources: Map<string, ResourceMetadata>): Promise<string[]> {
  const connection = await lancedb.connect(suite.dbPath);
  const table = await connection.openTable(DOCUMENTS_TABLE);
  // eslint-disable-next-line unicorn/prefer-structured-clone -- Arrow buffer lifecycle workaround, as in the provider
  const rows = JSON.parse(JSON.stringify(await table.query().toArray())) as DocumentRecord[];
  const tokenCounter = new ApproximateTokenCounter();
  const oldRows = rows.map((row) => {
    const resource = resources.get(row.resourceid);
    if (!resource) throw new Error(`no resource for row ${row.resourceid}`);
    return createDocumentRecordAtV0_1_42(
      resource,
      row.content,
      row.contenthash,
      row.totalchunks,
      tokenCounter,
      DefaultRAGMetadataSchema,
    );
  });
  await connection.dropTable(DOCUMENTS_TABLE);
  const rewritten = await connection.createTable(DOCUMENTS_TABLE, oldRows);
  const columns = (await rewritten.schema()).fields.map((field) => field.name);
  connection.close();
  return columns;
}

/**
 * @returns A provider over the suite's database with document storage on and a runtime-free embedder
 */
function openWithDocuments(): Promise<LanceDBRAGProvider> {
  return LanceDBRAGProvider.create({
    dbPath: suite.dbPath,
    storeDocuments: true,
    embeddingProvider: createStubEmbeddingProvider(),
  });
}

describe('documents table written by v0.1.42', () => {
  it('re-indexes a changed resource instead of deleting it and refusing the replacement', async () => {
    const aPath = await createTestMarkdownFile(suite.tempDir, 'a.md', '---\ntitle: A\n---\n\n# A\n\nprose a\n');
    const bPath = await createTestMarkdownFile(suite.tempDir, 'b.md', '---\ntitle: B\n---\n\n# B\n\nprose b\n');
    const a = await createTestResource(aPath, 'a');
    const b = await createTestResource(bPath, 'b');

    suite.provider = await openWithDocuments();
    const first = await suite.provider.indexResources([a, b]);
    expect(first.errors).toEqual([]);
    expect(first.resourcesIndexed).toBe(2);
    await suite.provider.close();

    // The fixture is real: the old shape lacks the columns this build writes.
    const oldColumns = await downgradeDocumentsTable(new Map([['a', a], ['b', b]]));
    expect(oldColumns).toContain('title');
    expect(oldColumns).not.toContain('headingpath');
    expect(oldColumns).not.toContain('tags');

    await createTestMarkdownFile(suite.tempDir, 'a.md', '---\ntitle: A\n---\n\n# A\n\nprose a CHANGED\n');
    const aChanged = await createTestResource(aPath, 'a');

    suite.provider = await openWithDocuments();
    const second = await suite.provider.indexResources([aChanged, b]);

    expect(second.errors).toEqual([]);
    expect(second.resourcesUpdated).toBe(1);
    expect(second.resourcesIndexed).toBe(1);
    expect(second.resourcesSkipped).toBe(1);

    // The changed resource is retrievable with its NEW content, beside its neighbour.
    const found = await suite.provider.query({ text: 'prose', limit: 10 });
    expect(found.chunks.map((chunk) => chunk.resourceId).sort((x, y) => x.localeCompare(y))).toEqual(['a', 'b']);
    expect(found.chunks.find((chunk) => chunk.resourceId === 'a')?.content).toContain('CHANGED');

    // Both document rows survive the widening: the rewritten one carries the
    // new content, the untouched one still reads its old title and reports
    // the columns it never had as absent rather than as empty strings.
    expect((await suite.provider.getDocument('a'))?.content).toContain('CHANGED');
    const untouched = await suite.provider.getDocument('b');
    expect(untouched?.metadata['title']).toBe('B');
    expect(untouched?.metadata).not.toHaveProperty('tags');
    expect(untouched?.metadata).not.toHaveProperty('headingPath');
  });

  it('is a no-op on a table this build wrote', async () => {
    const path = await createTestMarkdownFile(suite.tempDir, 'c.md', '# C\n\nprose c\n');
    const c = await createTestResource(path, 'c');

    suite.provider = await openWithDocuments();
    await suite.provider.indexResources([c]);
    const connection = await lancedb.connect(suite.dbPath);
    const table = await connection.openTable(DOCUMENTS_TABLE);
    const versionBefore = await table.version();
    connection.close();

    // A second run over an unchanged corpus commits nothing to the documents table.
    const rerun = await suite.provider.indexResources([c]);
    expect(rerun.resourcesSkipped).toBe(1);

    const again = await lancedb.connect(suite.dbPath);
    expect(await (await again.openTable(DOCUMENTS_TABLE)).version()).toBe(versionBefore);
    again.close();
  });
});

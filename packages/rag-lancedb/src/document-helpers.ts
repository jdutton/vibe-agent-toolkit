/**
 * Pure logic helpers for document storage and metadata overlay.
 *
 * Extracted from LanceDBRAGProvider to enable direct unit testing
 * without LanceDB dependencies.
 */

import type { CoreRAGChunk, TokenCounter } from '@vibe-agent-toolkit/rag';
import type { ResourceMetadata } from '@vibe-agent-toolkit/resources';
import type { ZodObject, ZodRawShape } from 'zod';

/**
 * Accumulated document record collected during indexing.
 * Stored to rag_documents table when storeDocuments is enabled.
 */
export interface DocumentRecord {
  resourceid: string;
  filepath: string;
  content: string;
  contenthash: string;
  tokencount: number;
  totalchunks: number;
  indexedat: number;
  [key: string]: string | number;
}

/**
 * Overlay custom metadata from resource frontmatter onto enriched RAG chunks.
 *
 * Copies matching frontmatter values (per the metadata schema keys) onto
 * each chunk, producing typed chunks with metadata included.
 *
 * @param ragChunks - Enriched RAG chunks to augment
 * @param frontmatter - Resource frontmatter (may be undefined)
 * @param metadataSchema - Zod schema defining the metadata fields
 * @returns Chunks with metadata overlaid
 */
export function overlayChunkMetadata<TMetadata extends Record<string, unknown>>(
  ragChunks: CoreRAGChunk[],
  frontmatter: Record<string, unknown> | undefined,
  metadataSchema: ZodObject<ZodRawShape>,
): (CoreRAGChunk & TMetadata)[] {
  return ragChunks.map((chunk) => {
    const chunkWithMetadata: Record<string, unknown> = { ...chunk };

    if (frontmatter) {
      for (const key of Object.keys(metadataSchema.shape)) {
        if (key in frontmatter) {
          chunkWithMetadata[key] = frontmatter[key];
        }
      }
    }

    return chunkWithMetadata as CoreRAGChunk & TMetadata;
  });
}

/**
 * Create a DocumentRecord for the rag_documents table.
 *
 * Builds the record from resource metadata, transformed content,
 * and overlays frontmatter fields using the metadata schema.
 *
 * @param resource - Resource metadata (id, filePath, frontmatter)
 * @param content - Transformed content to store
 * @param contentHash - Content hash for change detection
 * @param totalChunks - Number of chunks created from this document
 * @param tokenCounter - Token counter for computing token count
 * @param metadataSchema - Zod schema defining the metadata fields
 * @returns DocumentRecord ready for LanceDB insertion
 */
export function createDocumentRecord(
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

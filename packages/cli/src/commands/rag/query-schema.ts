/**
 * The document `vat rag query` publishes, apart from the command (see
 * `index-schema.ts` for why a sibling, and why no runtime import of the RAG
 * packages).
 *
 * `examined` counts the chunks in the index searched, so a query that matches
 * nothing over a populated index is `ok` with `chunks: []`. An index with no
 * data — no chunk table, or a table of zero chunks — refuses before searching
 * (`INPUT_UNREADABLE`, exit 2), so the zero-examined remedy below is the
 * writer's backstop, not an outcome a run reaches.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat rag query`, and the remedy when it is zero. */
export const RAG_QUERY_EXAMINED: ExaminedDeclaration = {
  unit: 'chunks in the index',
  whenZero: 'The index holds no chunk to search: run vat rag index first, and check its findings for documents that failed.',
};

/** One matched chunk. Optional fields are omitted when the chunk has none. */
const RagQueryChunkSchema = z.object({
  chunkId: z.string(),
  resourceId: z.string(),
  /** The chunk's source file, relative to `root`. */
  filePath: z.string(),
  headingPath: z.string().optional(),
  headingLevel: z.number().int().optional(),
  startLine: z.number().int().optional(),
  endLine: z.number().int().optional(),
  title: z.string().optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  contentHash: z.string(),
  tokenCount: z.number().int().nonnegative(),
  embeddingModel: z.string(),
  /** ISO 8601. */
  embeddedAt: z.string(),
  previousChunkId: z.string().optional(),
  nextChunkId: z.string().optional(),
  /** The full chunk text, never truncated; last so a long result stays scannable. */
  content: z.string(),
}).strict();

const RagQueryDataSchema = z.object({
  /** The directory every `filePath` is relative to: the only absolute path. */
  root: z.string(),
  query: z.string(),
  /** Mirrors `RAGResult.stats` from `@vibe-agent-toolkit/rag`. */
  stats: z.object({
    totalMatches: z.number().int().nonnegative(),
    searchDurationMs: z.number().nonnegative(),
    embedding: z.object({
      model: z.string(),
      tokensUsed: z.number().optional(),
    }).strict().optional(),
  }).strict(),
  chunks: z.array(RagQueryChunkSchema),
}).strict();

export type RagQueryData = z.infer<typeof RagQueryDataSchema>;

/** The document this command publishes. */
export const RAG_QUERY_REPORT_SCHEMA = reportSchema(RagQueryDataSchema, FindingSchema);

export type RagQueryReport = Report<RagQueryData>;

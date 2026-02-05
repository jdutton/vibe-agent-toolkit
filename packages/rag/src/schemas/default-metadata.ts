/**
 * Default RAG Metadata Zod schema
 *
 * Defines sensible default metadata fields for markdown-centric RAG.
 */

import { z } from 'zod';

/**
 * DefaultRAGMetadataSchema
 *
 * Zod schema for default metadata fields.
 * Optimized for markdown documentation with headings and structure.
 */
export const DefaultRAGMetadataSchema = z.object({
  // Source tracking
  filePath: z.string().describe('Source file path (or URL, package ref, S3 URI, etc.)'),

  // Optional markdown-centric fields
  tags: z.array(z.string()).optional().describe('Resource tags for filtering'),
  type: z.string().optional().describe('Resource type (e.g., "documentation", "api-reference")'),
  title: z.string().optional().describe('Resource title'),
  headingPath: z.string().optional().describe('Full heading hierarchy: "Architecture > RAG Design"'),
  headingLevel: z.number().optional().describe('Heading level (1-6) if chunk is under a heading'),
  startLine: z.number().optional().describe('Starting line number in source file'),
  endLine: z.number().optional().describe('Ending line number in source file'),
});

/**
 * DefaultRAGMetadata TypeScript type (inferred from schema)
 */
export type DefaultRAGMetadata = z.infer<typeof DefaultRAGMetadataSchema>;

import { z } from 'zod';

import { SHA256Schema } from './checksum.js';

/**
 * Type of link found in markdown resources.
 *
 * - `local_file`: Link to a local file (relative or absolute path)
 * - `anchor`: Link to a heading anchor (e.g., #heading-slug)
 * - `external`: HTTP/HTTPS URL to external resource
 * - `email`: Mailto link
 * - `unknown`: Unclassified link type
 */
export const LinkTypeSchema = z.enum([
  'local_file',
  'anchor',
  'external',
  'email',
  'unknown',
]).describe('Type of link found in markdown resources');

export type LinkType = z.infer<typeof LinkTypeSchema>;

/**
 * Represents a heading node in the document's table of contents.
 *
 * Forms a recursive tree structure where child headings are nested under parent headings
 * based on their level (e.g., h3 nodes are children of the preceding h2).
 */
export type HeadingNode = {
  level: number;
  text: string;
  slug: string;
  line?: number | undefined;
  children?: HeadingNode[] | undefined;
};

/**
 * Zod schema for heading nodes in the document's table of contents.
 *
 * This is a recursive schema using z.lazy() to handle the self-referential structure.
 * The type is defined separately above to work with TypeScript's exactOptionalPropertyTypes.
 */
export const HeadingNodeSchema: z.ZodType<HeadingNode> = z.lazy(() =>
  z.object({
    level: z.number().int().min(1).max(6).describe('Heading level (1-6)'),
    text: z.string().describe('Raw text content of the heading'),
    slug: z.string().describe('GitHub-style slug for anchor links (lowercase, hyphenated)'),
    line: z.number().int().positive().optional().describe('Line number in source file'),
    children: z.array(HeadingNodeSchema).optional().describe('Nested child headings'),
  }).describe('Heading node in the document\'s table of contents')
);

/**
 * Represents a link found in a markdown resource.
 *
 * Includes the raw link data from markdown as well as resolved paths and IDs
 * for link validation and cross-referencing.
 */
export const ResourceLinkSchema = z.object({
  text: z.string().describe('Link text displayed to users'),
  href: z.string().describe('Raw href attribute from markdown'),
  type: LinkTypeSchema.describe('Classified link type'),
  line: z.number().int().positive().optional().describe('Line number in source file'),
  resolvedPath: z.string().optional().describe('Absolute file path (for local_file links)'),
  anchorTarget: z.string().optional().describe('Target heading slug (for anchor links)'),
  resolvedId: z.string().optional().describe('Resolved resource ID in the collection (for local_file links)'),
}).describe('Link found in a markdown resource');

export type ResourceLink = z.infer<typeof ResourceLinkSchema>;

/**
 * Complete metadata for a markdown resource.
 *
 * Includes all parsed information about the resource: its links, headings structure,
 * file stats, and identifiers. Supports YAML frontmatter parsing.
 */
export const ResourceMetadataSchema = z.object({
  id: z.string().describe('Unique identifier (inferred from filePath or overridden by frontmatter)'),
  filePath: z.string().describe('Absolute path to the resource file'),
  links: z.array(ResourceLinkSchema).describe('All links found in the resource'),
  headings: z.array(HeadingNodeSchema).describe('Document table of contents (top-level headings only; children are nested)'),
  frontmatter: z.record(z.string(), z.unknown()).optional()
    .describe('Parsed YAML frontmatter (if present in markdown file)'),
  frontmatterError: z.string().optional()
    .describe('YAML parsing error message (if frontmatter contains invalid YAML syntax)'),
  sizeBytes: z.number().int().nonnegative().describe('File size in bytes'),
  estimatedTokenCount: z.number().int().nonnegative().describe('Estimated token count for LLM context (roughly 1 token per 4 chars)'),
  modifiedAt: z.date().describe('Last modified timestamp'),
  checksum: SHA256Schema.describe('SHA-256 checksum of file content'),
  collections: z.array(z.string()).optional()
    .describe('Collection names this resource belongs to (populated when using config-based discovery)'),
}).describe('Complete metadata for a markdown resource');

export type ResourceMetadata = z.infer<typeof ResourceMetadataSchema>;

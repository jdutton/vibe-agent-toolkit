/**
 * Core resource type system for vibe-agent-toolkit
 *
 * Defines discriminated unions for different resource types with unified interface.
 * All resources use projectPath (relative, forward slashes) for serialization,
 * with optional absolutePath for runtime operations.
 */

import type { SHA256 } from '../schemas/checksum.js';

/**
 * Resource type discriminator for type-safe handling
 */
export enum ResourceType {
  MARKDOWN = 'markdown',
  JSON_SCHEMA = 'json-schema',
  JSON = 'json',
  YAML = 'yaml',
}

/**
 * Simple heading structure for Phase 1
 * Expanded in future phases
 */
export interface Heading {
  level: number;
  text: string;
  id?: string;
}

/**
 * Base resource properties shared by all resource types
 */
export interface BaseResource {
  /** Unique identifier for this resource */
  id: string;

  /** Relative path from project root (forward slashes, no leading /) */
  projectPath: string;

  /** Absolute path computed at runtime (never serialized) */
  absolutePath?: string;

  /** Resource type discriminator */
  type: ResourceType;

  /** MIME type for the resource */
  mimeType: string;

  /** File size in bytes */
  sizeBytes: number;

  /** Last modification timestamp */
  modifiedAt: Date;

  /** SHA-256 checksum of file content */
  checksum: SHA256;

  /** Collections this resource belongs to (empty for Phase 1) */
  collections: string[];
}

/**
 * Markdown resource with parsed content and metadata
 */
export interface MarkdownResource extends BaseResource {
  type: ResourceType.MARKDOWN;
  mimeType: 'text/markdown';

  /** Parsed YAML frontmatter (if present) */
  frontmatter?: Record<string, unknown>;

  /** JSON Schema paths referenced by this resource */
  schemas: string[];

  /** Raw markdown content */
  content: string;

  /** Link hrefs found in content */
  links: string[];

  /** Document heading structure */
  headings: Heading[];

  /** Estimated token count (chars / 4) */
  estimatedTokenCount: number;
}

/**
 * JSON Schema resource
 */
export interface JsonSchemaResource extends BaseResource {
  type: ResourceType.JSON_SCHEMA;
  mimeType: 'application/schema+json';

  /** Parsed schema object */
  schema: object;

  /** Schema $id field (if present) */
  schemaId?: string;

  /** Schema version (from $schema field) */
  schemaVersion?: string;

  /** Schema title (if present) */
  title?: string;

  /** Schema description (if present) */
  description?: string;

  /** Resource IDs that reference this schema */
  referencedBy: string[];
}

/**
 * JSON resource (not a schema)
 */
export interface JsonResource extends BaseResource {
  type: ResourceType.JSON;
  mimeType: 'application/json';

  /** Parsed JSON data */
  data: unknown;

  /** JSON Schema paths that validate this resource */
  schemas?: string[];
}

/**
 * YAML resource
 */
export interface YamlResource extends BaseResource {
  type: ResourceType.YAML;
  mimeType: 'application/yaml';

  /** Parsed YAML data */
  data: unknown;

  /** JSON Schema paths that validate this resource */
  schemas?: string[];
}

/**
 * Union type for all resource types
 */
export type Resource = MarkdownResource | JsonSchemaResource | JsonResource | YamlResource;

// ============================================================================
// JSON Schema Detection
// ============================================================================

/**
 * JSON Schema keywords for heuristic detection
 * See: https://json-schema.org/understanding-json-schema/reference/
 */
const SCHEMA_KEYWORDS = [
  '$schema',
  '$id',
  'title',
  'description',
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'definitions',
  '$defs',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
] as const;

/**
 * Detect if data is likely a JSON Schema using heuristics
 *
 * Returns true if data is an object with 2+ recognized schema keywords.
 * This heuristic catches schemas without explicit $schema field.
 *
 * @param data - Data to check
 * @returns true if data appears to be a JSON Schema
 */
export function isJsonSchema(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return false;
  }

  const matchCount = SCHEMA_KEYWORDS.filter((keyword) => keyword in data).length;
  return matchCount >= 2;
}

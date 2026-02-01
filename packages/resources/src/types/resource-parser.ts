/**
 * Resource parsing functions
 *
 * Parses files into typed Resource objects with proper metadata extraction.
 * Handles markdown, JSON, JSON Schema, and YAML formats.
 */

import { promises as fs } from 'node:fs';

import yaml from 'js-yaml';

import { calculateChecksum } from '../checksum.js';
import { parseMarkdown } from '../link-parser.js';
import type { HeadingNode, ResourceLink } from '../schemas/resource-metadata.js';

import type {
  Heading,
  JsonResource,
  JsonSchemaResource,
  MarkdownResource,
  YamlResource,
} from './resources.js';
import { isJsonSchema, ResourceType } from './resources.js';

/**
 * Parse markdown file into MarkdownResource
 *
 * @param absolutePath - Absolute path to markdown file
 * @param projectPath - Relative path from project root
 * @param collectionName - Collection this resource belongs to
 * @returns Parsed MarkdownResource
 */
export async function parseMarkdownResource(
  absolutePath: string,
  projectPath: string,
  collectionName: string,
): Promise<MarkdownResource> {
  // Get file stats
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const stats = await fs.stat(absolutePath);

  // Parse markdown content
  const parsed = await parseMarkdown(absolutePath);

  // Calculate checksum
  const checksum = await calculateChecksum(absolutePath);

  // Extract link hrefs
  const links = parsed.links.map((link: ResourceLink) => link.href);

  // Convert HeadingNode[] to Heading[]
  const headings: Heading[] = convertHeadingsToSimple(parsed.headings);

  // Estimate token count (chars / 4)
  const estimatedTokenCount = Math.floor(parsed.content.length / 4);

  const resource: MarkdownResource = {
    id: projectPath,
    projectPath,
    absolutePath,
    type: ResourceType.MARKDOWN,
    mimeType: 'text/markdown',
    sizeBytes: stats.size,
    modifiedAt: stats.mtime,
    checksum,
    collections: [collectionName],
    schemas: [],
    content: parsed.content,
    links,
    headings,
    estimatedTokenCount,
  };

  // Only set frontmatter if it exists (exactOptionalPropertyTypes)
  if (parsed.frontmatter !== undefined) {
    resource.frontmatter = parsed.frontmatter;
  }

  return resource;
}

/**
 * Parse JSON Schema file into JsonSchemaResource
 *
 * @param absolutePath - Absolute path to JSON Schema file
 * @param projectPath - Relative path from project root
 * @param collectionName - Collection this resource belongs to
 * @returns Parsed JsonSchemaResource
 */
export async function parseJsonSchemaResource(
  absolutePath: string,
  projectPath: string,
  collectionName: string,
): Promise<JsonSchemaResource> {
  // Get file stats
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const stats = await fs.stat(absolutePath);

  // Read and parse JSON
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const content = await fs.readFile(absolutePath, 'utf-8');
  const schema = JSON.parse(content) as object & {
    $id?: string;
    $schema?: string;
    title?: string;
    description?: string;
  };

  // Calculate checksum
  const checksum = await calculateChecksum(absolutePath);

  // Build resource with required fields
  const resource: JsonSchemaResource = {
    id: projectPath,
    projectPath,
    absolutePath,
    type: ResourceType.JSON_SCHEMA,
    mimeType: 'application/schema+json',
    sizeBytes: stats.size,
    modifiedAt: stats.mtime,
    checksum,
    collections: [collectionName],
    schema,
    referencedBy: [],
  };

  // Only set optional fields if they exist (exactOptionalPropertyTypes)
  if (schema.$id !== undefined) {
    resource.schemaId = schema.$id;
  }
  if (schema.$schema !== undefined) {
    resource.schemaVersion = schema.$schema;
  }
  if (schema.title !== undefined) {
    resource.title = schema.title;
  }
  if (schema.description !== undefined) {
    resource.description = schema.description;
  }

  return resource;
}

/**
 * Parse JSON file into JsonResource
 *
 * @param absolutePath - Absolute path to JSON file
 * @param projectPath - Relative path from project root
 * @param collectionName - Collection this resource belongs to
 * @returns Parsed JsonResource
 */
export async function parseJsonResource(
  absolutePath: string,
  projectPath: string,
  collectionName: string,
): Promise<JsonResource> {
  // Get file stats
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const stats = await fs.stat(absolutePath);

  // Read and parse JSON
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const content = await fs.readFile(absolutePath, 'utf-8');
  const data: unknown = JSON.parse(content);

  // Calculate checksum
  const checksum = await calculateChecksum(absolutePath);

  return {
    id: projectPath,
    projectPath,
    absolutePath,
    type: ResourceType.JSON,
    mimeType: 'application/json',
    sizeBytes: stats.size,
    modifiedAt: stats.mtime,
    checksum,
    collections: [collectionName],
    data,
  };
}

/**
 * Parse YAML file into YamlResource
 *
 * @param absolutePath - Absolute path to YAML file
 * @param projectPath - Relative path from project root
 * @param collectionName - Collection this resource belongs to
 * @returns Parsed YamlResource
 */
export async function parseYamlResource(
  absolutePath: string,
  projectPath: string,
  collectionName: string,
): Promise<YamlResource> {
  // Get file stats
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const stats = await fs.stat(absolutePath);

  // Read and parse YAML
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const content = await fs.readFile(absolutePath, 'utf-8');
  const data = yaml.load(content);

  // Calculate checksum
  const checksum = await calculateChecksum(absolutePath);

  return {
    id: projectPath,
    projectPath,
    absolutePath,
    type: ResourceType.YAML,
    mimeType: 'application/yaml',
    sizeBytes: stats.size,
    modifiedAt: stats.mtime,
    checksum,
    collections: [collectionName],
    data,
  };
}

/**
 * Detect resource type from file path and content
 *
 * @param filePath - Path to file
 * @param data - Parsed data (for JSON/YAML detection)
 * @returns Detected ResourceType
 */
export function detectResourceType(filePath: string, data?: unknown): ResourceType {
  const ext = filePath.toLowerCase().split('.').pop();

  // Check extension first
  if (ext === 'md' || ext === 'markdown') {
    return ResourceType.MARKDOWN;
  }

  if (ext === 'yaml' || ext === 'yml') {
    return ResourceType.YAML;
  }

  if (ext === 'json') {
    // Use heuristics to detect JSON Schema
    if (data && isJsonSchema(data)) {
      return ResourceType.JSON_SCHEMA;
    }
    return ResourceType.JSON;
  }

  // Default fallback
  if (data && typeof data === 'object' && isJsonSchema(data)) {
    return ResourceType.JSON_SCHEMA;
  }

  return ResourceType.JSON; // Default
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Convert HeadingNode[] to simple Heading[] for Phase 1
 *
 * @param nodes - Parsed heading nodes
 * @returns Simplified heading array
 */
function convertHeadingsToSimple(nodes: HeadingNode[]): Heading[] {
  const result: Heading[] = [];

  function traverse(node: HeadingNode): void {
    result.push({
      level: node.level,
      text: node.text,
      id: node.slug,
    });

    if (node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }

  for (const node of nodes) {
    traverse(node);
  }

  return result;
}

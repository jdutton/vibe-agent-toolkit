/**
 * Schema assignment pipeline for resources
 *
 * Handles the multi-source schema assignment:
 * 1. Self-asserted schemas (from $schema field in frontmatter)
 * 2. Collection-imposed schemas (from collection config)
 * 3. CLI-imposed schemas (from --frontmatter-schema flag)
 *
 * Each resource can have multiple schemas from different sources,
 * and each is validated independently.
 */

import type { CollectionConfig } from './schemas/project-config.js';
import type { SchemaReference } from './types/resources.js';

/**
 * Add collection-imposed schema to a resource's schema list
 *
 * @param existingSchemas - Current schemas (including self-asserted)
 * @param collectionName - Name of the collection
 * @param collectionConfig - Collection configuration
 * @returns Updated schema list with collection schema added (if defined)
 */
export function addCollectionSchema(
  existingSchemas: SchemaReference[],
  collectionName: string,
  collectionConfig: CollectionConfig,
): SchemaReference[] {
  const schemaPath = collectionConfig.validation?.frontmatterSchema;

  if (!schemaPath) {
    return existingSchemas;
  }

  // Check if this schema is already present from any source
  const alreadyExists = existingSchemas.some((ref) => ref.schema === schemaPath);
  if (alreadyExists) {
    return existingSchemas;
  }

  // Add collection-imposed schema
  return [
    ...existingSchemas,
    {
      schema: schemaPath,
      source: collectionName,
      applied: false,
    },
  ];
}

/**
 * Add CLI-imposed schema to a resource's schema list
 *
 * @param existingSchemas - Current schemas (including self-asserted and collection)
 * @param schemaPath - Path to schema from CLI flag
 * @returns Updated schema list with CLI schema added
 */
export function addCLISchema(
  existingSchemas: SchemaReference[],
  schemaPath: string,
): SchemaReference[] {
  // Check if this schema is already present from any source
  const alreadyExists = existingSchemas.some((ref) => ref.schema === schemaPath);
  if (alreadyExists) {
    return existingSchemas;
  }

  // Add CLI-imposed schema
  return [
    ...existingSchemas,
    {
      schema: schemaPath,
      source: 'cli',
      applied: false,
    },
  ];
}

/**
 * Apply schema assignments to a resource
 *
 * Pipeline order:
 * 1. Self-asserted (already in resource.schemas from parser)
 * 2. Collection-imposed (from each collection the resource belongs to)
 * 3. CLI-imposed (from --frontmatter-schema flag)
 *
 * Deduplicates schemas by path - same schema from multiple sources
 * only appears once (first source wins).
 *
 * @param resourceSchemas - Current schemas (from parser)
 * @param collections - Collections this resource belongs to
 * @param collectionsConfig - Collection configurations
 * @param cliSchema - Optional CLI-imposed schema
 * @returns Complete list of schemas to validate
 */
export function assignSchemas(
  resourceSchemas: SchemaReference[],
  collections: string[],
  collectionsConfig: Record<string, CollectionConfig>,
  cliSchema?: string,
): SchemaReference[] {
  let schemas = resourceSchemas;

  // Add collection-imposed schemas
  for (const collectionName of collections) {
    const collectionConfig = collectionsConfig[collectionName];
    if (collectionConfig) {
      schemas = addCollectionSchema(schemas, collectionName, collectionConfig);
    }
  }

  // Add CLI-imposed schema
  if (cliSchema) {
    schemas = addCLISchema(schemas, cliSchema);
  }

  return schemas;
}

/**
 * Lazy query builder for filtering and transforming resource collections.
 *
 * ResourceQuery uses lazy evaluation - operations are not executed until
 * execute() or toCollection() is called. This allows for efficient
 * chaining and optimization of operations.
 *
 * @example
 * ```typescript
 * const query = ResourceQuery.from(registry.getAllResources())
 *   .filter(r => r.links.length > 5)
 *   .map(r => ({ id: r.id, path: r.filePath }));
 *
 * const results = query.execute(); // Operations executed here
 * ```
 */

import { ResourceCollection } from './resource-collection.js';
import type { ResourceMetadata } from './schemas/resource-metadata.js';
import { matchesGlobPattern } from './utils.js';

/**
 * Predicate function for filtering resources.
 */
type FilterPredicate = (resource: ResourceMetadata) => boolean;

/**
 * Transformer function for mapping resources.
 */
type MapTransformer = (resource: ResourceMetadata) => ResourceMetadata;

/**
 * Lazy query builder for resource collections.
 *
 * Operations are stored and only executed when execute() or toCollection() is called.
 */
export class ResourceQuery {
  private readonly source: ResourceMetadata[];
  private readonly filters: FilterPredicate[] = [];
  private readonly mappers: MapTransformer[] = [];

  /**
   * Private constructor - use ResourceQuery.from() to create instances.
   *
   * @param source - Source array of resources
   */
  private constructor(source: ResourceMetadata[]) {
    this.source = source;
  }

  /**
   * Create a ResourceQuery from an array of resources.
   *
   * @param resources - Array of resources to query
   * @returns New ResourceQuery instance
   *
   * @example
   * ```typescript
   * const query = ResourceQuery.from(registry.getAllResources());
   * ```
   */
  static from(resources: ResourceMetadata[]): ResourceQuery {
    return new ResourceQuery(resources);
  }

  /**
   * Filter resources by a predicate function.
   *
   * Lazily stores the filter - not executed until execute() is called.
   * Multiple filters can be chained and will be applied in order.
   *
   * @param predicate - Function that returns true for resources to keep
   * @returns This query for chaining
   *
   * @example
   * ```typescript
   * const query = ResourceQuery.from(resources)
   *   .filter(r => r.links.length > 0)
   *   .filter(r => r.sizeBytes < 10000);
   * ```
   */
  filter(predicate: FilterPredicate): this {
    this.filters.push(predicate);
    return this;
  }

  /**
   * Transform resources with a mapping function.
   *
   * Lazily stores the transformation - not executed until execute() is called.
   * Multiple map operations can be chained and will be applied in order.
   *
   * @param transformer - Function that transforms each resource
   * @returns This query for chaining
   *
   * @example
   * ```typescript
   * const query = ResourceQuery.from(resources)
   *   .map(r => ({ ...r, id: r.id.toUpperCase() }));
   * ```
   */
  map(transformer: MapTransformer): this {
    this.mappers.push(transformer);
    return this;
  }

  /**
   * Filter resources by glob pattern matching their file paths.
   *
   * Uses picomatch for pattern matching with Unix-style paths.
   * Supports patterns like '**\/*.md', 'docs/**', '*.ts', etc.
   *
   * @param pattern - Glob pattern to match against file paths
   * @returns This query for chaining
   *
   * @example
   * ```typescript
   * const query = ResourceQuery.from(resources)
   *   .matchesPattern('docs/**')
   *   .matchesPattern('*.md');
   * ```
   */
  matchesPattern(pattern: string): this {
    this.filters.push((resource) => matchesGlobPattern(resource.filePath, pattern));
    return this;
  }

  /**
   * Execute the query and return the results.
   *
   * Materializes all lazy operations and returns the final array.
   *
   * @returns Array of resources after all operations
   *
   * @example
   * ```typescript
   * const results = query.execute();
   * console.log(`Found ${results.length} resources`);
   * ```
   */
  execute(): ResourceMetadata[] {
    let results = this.source;

    // Apply all filters in order
    for (const filter of this.filters) {
      results = results.filter(filter);
    }

    // Apply all mappers in order
    for (const mapper of this.mappers) {
      results = results.map(mapper);
    }

    return results;
  }

  /**
   * Execute the query and return a ResourceCollection.
   *
   * Materializes all lazy operations and wraps the results in a
   * ResourceCollection for duplicate detection and collection operations.
   *
   * @returns ResourceCollection containing the query results
   *
   * @example
   * ```typescript
   * const collection = query.toCollection();
   * console.log(`Found ${collection.size()} resources`);
   * const duplicates = collection.getDuplicates();
   * ```
   */
  toCollection(): ResourceCollection {
    return new ResourceCollection(this.execute());
  }
}

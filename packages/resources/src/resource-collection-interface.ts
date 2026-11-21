/**
 * Interface for resource collections that support duplicate detection and filtering.
 *
 * This interface is implemented by ResourceRegistry and ResourceCollection
 * to provide a consistent API for working with collections of resources.
 *
 * @example
 * ```typescript
 * const collection: ResourceCollectionInterface = new ResourceRegistry();
 * console.log(collection.size());
 * console.log(collection.isEmpty());
 * const duplicates = collection.getDuplicates();
 * ```
 */

import type { ResourceMetadata } from './schemas/resource-metadata.js';

/**
 * Interface for collections of resources with duplicate detection.
 */
export interface ResourceCollectionInterface {
  /**
   * Get the number of resources in the collection.
   *
   * @returns Number of resources
   */
  size(): number;

  /**
   * Check if the collection is empty.
   *
   * @returns True if the collection has no resources
   */
  isEmpty(): boolean;

  /**
   * Get all resources in the collection.
   *
   * @returns Array of all resources
   */
  getAllResources(): ResourceMetadata[];

  /**
   * Get groups of duplicate resources based on content key.
   *
   * Returns an array where each element is an array of resources
   * that have the same content key (identical bytes, same parse route).
   * Only groups with 2+ resources are included. Identical bytes routed to
   * different parsers are not duplicates: the key includes the parse route.
   *
   * @returns Array of duplicate groups
   *
   * @example
   * ```typescript
   * const duplicates = collection.getDuplicates();
   * // [[resource1, resource2], [resource3, resource4, resource5]]
   * ```
   */
  getDuplicates(): ResourceMetadata[][];

  /**
   * Get one representative resource for each unique content key.
   *
   * When multiple resources have the same content key, only the first
   * one encountered is included in the result.
   *
   * @returns Array of unique resources (one per content key)
   *
   * @example
   * ```typescript
   * const unique = collection.getUniqueByContentKey();
   * // All resources have different content keys
   * ```
   */
  getUniqueByContentKey(): ResourceMetadata[];
}

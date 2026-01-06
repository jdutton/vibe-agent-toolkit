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
   * Get groups of duplicate resources based on checksum.
   *
   * Returns an array where each element is an array of resources
   * that have the same checksum (i.e., identical content).
   * Only groups with 2+ resources are included.
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
   * Get one representative resource for each unique checksum.
   *
   * When multiple resources have the same checksum, only the first
   * one encountered is included in the result.
   *
   * @returns Array of unique resources (one per checksum)
   *
   * @example
   * ```typescript
   * const unique = collection.getUniqueByChecksum();
   * // All resources have different checksums
   * ```
   */
  getUniqueByChecksum(): ResourceMetadata[];
}

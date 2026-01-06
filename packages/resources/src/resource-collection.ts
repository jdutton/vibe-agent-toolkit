/**
 * Immutable collection of resources with lazy duplicate detection.
 *
 * ResourceCollection wraps an array of resources and provides efficient
 * duplicate detection and filtering operations. Duplicate detection is
 * performed lazily - the collection builds checksum indexes only when
 * getDuplicates() or getUniqueByChecksum() is first called.
 *
 * @example
 * ```typescript
 * const collection = new ResourceCollection([resource1, resource2, resource3]);
 *
 * console.log(collection.size());
 * const duplicates = collection.getDuplicates();
 * const unique = collection.getUniqueByChecksum();
 * ```
 */

import type { ResourceCollectionInterface } from './resource-collection-interface.js';
import type { SHA256 } from './schemas/checksum.js';
import type { ResourceMetadata } from './schemas/resource-metadata.js';

/**
 * Immutable collection of resources with lazy duplicate detection.
 *
 * This class implements the ResourceCollectionInterface and provides
 * efficient operations for working with collections of resources.
 * Duplicate detection is lazy - checksum indexes are only built when needed.
 */
export class ResourceCollection implements ResourceCollectionInterface {
  private readonly resources: ResourceMetadata[];
  private checksumIndex: Map<SHA256, ResourceMetadata[]> | null = null;

  /**
   * Create a new ResourceCollection from an array of resources.
   *
   * @param resources - Array of resources to wrap
   *
   * @example
   * ```typescript
   * const collection = new ResourceCollection([resource1, resource2]);
   * ```
   */
  constructor(resources: ResourceMetadata[]) {
    this.resources = resources;
  }

  /**
   * Get the number of resources in the collection.
   *
   * @returns Number of resources
   */
  size(): number {
    return this.resources.length;
  }

  /**
   * Check if the collection is empty.
   *
   * @returns True if the collection has no resources
   */
  isEmpty(): boolean {
    return this.resources.length === 0;
  }

  /**
   * Get all resources in the collection.
   *
   * @returns Array of all resources
   */
  getAllResources(): ResourceMetadata[] {
    return this.resources;
  }

  /**
   * Get groups of duplicate resources based on checksum.
   *
   * Lazily builds a checksum index on first call. Returns an array where
   * each element is an array of resources that have the same checksum
   * (i.e., identical content). Only groups with 2+ resources are included.
   *
   * @returns Array of duplicate groups
   */
  getDuplicates(): ResourceMetadata[][] {
    this.ensureChecksumIndex();
    if (!this.checksumIndex) {
      return [];
    }
    const duplicateGroups: ResourceMetadata[][] = [];
    for (const group of this.checksumIndex.values()) {
      if (group.length >= 2) {
        duplicateGroups.push(group);
      }
    }
    return duplicateGroups;
  }

  /**
   * Get one representative resource for each unique checksum.
   *
   * Lazily builds a checksum index on first call. When multiple resources
   * have the same checksum, only the first one encountered is included
   * in the result.
   *
   * @returns Array of unique resources (one per checksum)
   */
  getUniqueByChecksum(): ResourceMetadata[] {
    this.ensureChecksumIndex();
    if (!this.checksumIndex) {
      return [];
    }
    const unique: ResourceMetadata[] = [];
    for (const group of this.checksumIndex.values()) {
      if (group[0]) {
        unique.push(group[0]);
      }
    }
    return unique;
  }

  /**
   * Ensure the checksum index is built.
   *
   * Builds the index on first call, subsequent calls do nothing.
   * This provides lazy evaluation for duplicate detection.
   */
  private ensureChecksumIndex(): void {
    if (this.checksumIndex !== null) {
      return;
    }

    this.checksumIndex = new Map();
    for (const resource of this.resources) {
      const group = this.checksumIndex.get(resource.checksum);
      if (group) {
        group.push(resource);
      } else {
        this.checksumIndex.set(resource.checksum, [resource]);
      }
    }
  }
}

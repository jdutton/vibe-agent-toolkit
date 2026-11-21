/**
 * Immutable collection of resources with lazy duplicate detection.
 *
 * ResourceCollection wraps an array of resources and provides efficient
 * duplicate detection and filtering operations. Duplicate detection is
 * performed lazily - the collection builds its content-key index only when
 * getDuplicates() or getUniqueByContentKey() is first called.
 *
 * @example
 * ```typescript
 * const collection = new ResourceCollection([resource1, resource2, resource3]);
 *
 * console.log(collection.size());
 * const duplicates = collection.getDuplicates();
 * const unique = collection.getUniqueByContentKey();
 * ```
 */

import type { ResourceCollectionInterface } from './resource-collection-interface.js';
import type { ResourceMetadata } from './schemas/resource-metadata.js';

/**
 * Immutable collection of resources with lazy duplicate detection.
 *
 * This class implements the ResourceCollectionInterface and provides
 * efficient operations for working with collections of resources.
 * Duplicate detection is lazy - the content-key index is only built when needed.
 */
export class ResourceCollection implements ResourceCollectionInterface {
  private readonly resources: ResourceMetadata[];
  private contentKeyIndex: Map<string, ResourceMetadata[]> | null = null;

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
   * Get groups of duplicate resources based on content key.
   *
   * Lazily builds a content-key index on first call. Returns an array where
   * each element is an array of resources that have the same content key
   * (identical bytes, same parse route). Only groups with 2+ resources are
   * included. Identical bytes routed to different parsers are not duplicates.
   *
   * @returns Array of duplicate groups
   */
  getDuplicates(): ResourceMetadata[][] {
    this.ensureContentKeyIndex();
    if (!this.contentKeyIndex) {
      return [];
    }
    const duplicateGroups: ResourceMetadata[][] = [];
    for (const group of this.contentKeyIndex.values()) {
      if (group.length >= 2) {
        duplicateGroups.push(group);
      }
    }
    return duplicateGroups;
  }

  /**
   * Get one representative resource for each unique content key.
   *
   * Lazily builds a content-key index on first call. When multiple resources
   * have the same content key, only the first one encountered is included
   * in the result.
   *
   * @returns Array of unique resources (one per content key)
   */
  getUniqueByContentKey(): ResourceMetadata[] {
    this.ensureContentKeyIndex();
    if (!this.contentKeyIndex) {
      return [];
    }
    const unique: ResourceMetadata[] = [];
    for (const group of this.contentKeyIndex.values()) {
      if (group[0]) {
        unique.push(group[0]);
      }
    }
    return unique;
  }

  /**
   * Ensure the content-key index is built.
   *
   * Builds the index on first call, subsequent calls do nothing.
   * This provides lazy evaluation for duplicate detection.
   */
  private ensureContentKeyIndex(): void {
    if (this.contentKeyIndex !== null) {
      return;
    }

    this.contentKeyIndex = new Map();
    for (const resource of this.resources) {
      const group = this.contentKeyIndex.get(resource.contentKey);
      if (group) {
        group.push(resource);
      } else {
        this.contentKeyIndex.set(resource.contentKey, [resource]);
      }
    }
  }
}

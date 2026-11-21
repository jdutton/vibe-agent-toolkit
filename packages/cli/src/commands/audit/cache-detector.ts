import path from 'node:path';

import type { ResourceMetadata } from '@vibe-agent-toolkit/resources';

export interface CacheStalenessResult {
  fresh: FreshEntry[];
  stale: StaleEntry[];
  cacheOnly: ResourceMetadata[];
  installedOnly: ResourceMetadata[];
}

export interface FreshEntry {
  installed: ResourceMetadata;
  cached: ResourceMetadata;
}

export interface StaleEntry {
  installed: ResourceMetadata;
  cached: ResourceMetadata;
}

/**
 * Extract filename from file path
 */
function getFileName(filePath: string): string {
  return path.basename(filePath);
}

/**
 * Detect cache staleness by comparing content keys between installed and cached resources.
 *
 * Compares resources by filename and content key to determine:
 * - Fresh: Cache and installed have matching content keys
 * - Stale: Cache and installed have different content keys
 * - Cache-only: File exists in cache but not in installed
 * - Installed-only: File exists in installed but not in cache
 *
 * Uses O(1) Map lookups for efficient matching.
 *
 * @param installed - Resources from installed plugin locations
 * @param cached - Resources from ~/.claude/plugins/cache/
 * @returns Categorized comparison results
 */
export function detectCacheStaleness(
  installed: ResourceMetadata[],
  cached: ResourceMetadata[]
): CacheStalenessResult {
  const fresh: FreshEntry[] = [];
  const stale: StaleEntry[] = [];
  const cacheOnly: ResourceMetadata[] = [];
  const installedOnly: ResourceMetadata[] = [];

  // Build index of installed resources by filename for O(1) lookup
  const installedByName = new Map<string, ResourceMetadata>();
  for (const resource of installed) {
    const filename = getFileName(resource.filePath);
    installedByName.set(filename, resource);
  }

  // Check each cached resource
  const matchedInstalledNames = new Set<string>();

  for (const cachedResource of cached) {
    const cachedFilename = getFileName(cachedResource.filePath);
    const installedResource = installedByName.get(cachedFilename);

    if (!installedResource) {
      // Cache file has no corresponding installed file
      cacheOnly.push(cachedResource);
      continue;
    }

    matchedInstalledNames.add(cachedFilename);

    if (cachedResource.contentKey === installedResource.contentKey) {
      // Content keys match - cache is fresh
      fresh.push({
        installed: installedResource,
        cached: cachedResource,
      });
    } else {
      // Content keys differ - cache is stale
      stale.push({
        installed: installedResource,
        cached: cachedResource,
      });
    }
  }

  // Find installed resources with no cache entry
  for (const [name, resource] of installedByName) {
    if (!matchedInstalledNames.has(name)) {
      installedOnly.push(resource);
    }
  }

  return { fresh, stale, cacheOnly, installedOnly };
}

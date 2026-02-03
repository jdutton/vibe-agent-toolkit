/**
 * Resources scan command - discover markdown resources
 */

import { formatDurationSecs } from '../../utils/duration.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';
import { loadResourcesWithConfig } from '../../utils/resource-loader.js';

import { handleCommandError } from './command-helpers.js';

interface ScanOptions {
  debug?: boolean;
  verbose?: boolean;
  collection?: string;
}

export async function scanCommand(
  pathArg: string | undefined,
  options: ScanOptions
): Promise<void> {
  const logger = createLogger({ debug: options.debug ?? false });
  const startTime = Date.now();

  try {
    // Load resources with config support
    const { registry } = await loadResourcesWithConfig(pathArg, logger);

    // Get all resources (filtered by collection if specified)
    let allResources = registry.getAllResources();
    if (options.collection) {
      const { collection } = options;
      allResources = allResources.filter(r => {
        return collection ? r.collections?.includes(collection) ?? false : false;
      });
    }

    // Calculate stats from filtered resources
    const totalLinks = allResources.reduce((sum, r) => sum + r.links.length, 0);
    const duration = Date.now() - startTime;

    // Count total headings (flatten the heading tree)
    type HeadingWithChildren = { children?: HeadingWithChildren[] | undefined };
    const countHeadings = (headings: HeadingWithChildren[]): number => {
      let count = headings.length;
      for (const heading of headings) {
        if (heading.children) {
          count += countHeadings(heading.children);
        }
      }
      return count;
    };

    const totalHeadings = allResources.reduce(
      (sum, resource) => sum + countHeadings(resource.headings),
      0
    );

    // Build collection stats (filtered or all)
    let collectionsOutput: Record<string, { resourceCount: number }> | undefined;
    if (options.collection) {
      // When filtering by collection, only show that collection
      collectionsOutput = { [options.collection]: { resourceCount: allResources.length } };
    } else {
      // Show all collections
      const collectionStats = registry.getCollectionStats();
      collectionsOutput = collectionStats
        ? Object.fromEntries(
            Object.entries(collectionStats.collections).map(([id, stat]) => [
              id,
              { resourceCount: stat.resourceCount },
            ])
          )
        : undefined;
    }

    // Output results as YAML
    const outputData: Record<string, unknown> = {
      status: 'success',
      filesScanned: allResources.length,
      linksFound: totalLinks,
      anchorsFound: totalHeadings,
      durationSecs: formatDurationSecs(duration),
      ...(collectionsOutput ? { collections: collectionsOutput } : {}),
    };

    // Add verbose file details if requested
    if (options.verbose) {
      outputData['files'] = allResources.map(resource => ({
        path: resource.filePath,
        links: resource.links.length,
        anchors: countHeadings(resource.headings),
        checksum: resource.checksum,
      }));
    }

    writeYamlOutput(outputData);

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Scan');
  }
}

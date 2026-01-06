/**
 * Resources scan command - discover markdown resources
 */

import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';
import { loadResourcesWithConfig } from '../../utils/resource-loader.js';

import { handleCommandError } from './command-helpers.js';

interface ScanOptions {
  debug?: boolean;
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

    const stats = registry.getStats();
    const duration = Date.now() - startTime;

    // Get all resources
    const allResources = registry.getAllResources();

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

    // Get duplicate statistics
    const duplicates = registry.getDuplicates();
    const duplicateFileCount = duplicates.reduce((sum, group) => sum + group.length, 0);
    const uniqueResources = registry.getUniqueByChecksum();

    // Output results as YAML
    writeYamlOutput({
      status: 'success',
      filesScanned: stats.totalResources,
      uniqueFiles: uniqueResources.length,
      duplicateGroups: duplicates.length,
      duplicateFiles: duplicateFileCount,
      linksFound: stats.totalLinks,
      anchorsFound: totalHeadings,
      files: allResources.map(resource => ({
        path: resource.filePath,
        links: resource.links.length,
        anchors: countHeadings(resource.headings),
        checksum: resource.checksum,
      })),
      duration: `${duration}ms`,
    });

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Scan');
  }
}

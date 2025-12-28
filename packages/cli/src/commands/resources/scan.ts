/**
 * Resources scan command - discover markdown resources
 */

import { ResourceRegistry } from '@vibe-agent-toolkit/resources';

import { loadConfig } from '../../utils/config-loader.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';
import { findProjectRoot } from '../../utils/project-root.js';

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
    // Determine scan path
    const scanPath = pathArg ?? process.cwd();
    logger.debug(`Scanning path: ${scanPath}`);

    // Find project root and load config
    const projectRoot = findProjectRoot(scanPath);
    const config = projectRoot ? loadConfig(projectRoot) : undefined;

    if (config && options.debug) {
      logger.debug(`Loaded config from ${projectRoot ?? 'unknown'}`);
    }

    // Create registry and crawl
    const registry = new ResourceRegistry();

    // Build crawl options with explicit undefined handling
    const crawlOptions = {
      baseDir: scanPath,
      ...(config?.resources?.include ? { include: config.resources.include } : {}),
      ...(config?.resources?.exclude ? { exclude: config.resources.exclude } : {}),
    };

    await registry.crawl(crawlOptions);

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

    // Output results as YAML
    writeYamlOutput({
      status: 'success',
      filesScanned: stats.totalResources,
      linksFound: stats.totalLinks,
      anchorsFound: totalHeadings,
      files: allResources.map(resource => ({
        path: resource.filePath,
        links: resource.links.length,
        anchors: countHeadings(resource.headings),
      })),
      duration: `${duration}ms`,
    });

    process.exit(0);
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(`Scan failed: ${error instanceof Error ? error.message : 'Unknown error'}`);

    writeYamlOutput({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: `${duration}ms`,
    });

    process.exit(2);
  }
}

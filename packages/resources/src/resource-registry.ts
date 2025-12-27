/**
 * Resource registry for managing collections of markdown resources.
 *
 * The registry maintains a collection of parsed markdown resources and provides:
 * - Resource addition and crawling
 * - Link validation across the registry
 * - Link resolution (setting resolvedId for local_file links)
 * - Query capabilities (by path, ID, or glob pattern)
 */

import path from 'node:path';

import { crawlDirectory, type CrawlOptions as UtilsCrawlOptions } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

import { parseMarkdown } from './link-parser.js';
import { validateLink } from './link-validator.js';
import type { HeadingNode, ResourceMetadata } from './schemas/resource-metadata.js';
import type { ValidationIssue, ValidationResult } from './schemas/validation-result.js';
import { splitHrefAnchor } from './utils.js';

/**
 * Options for crawling directories to add resources.
 */
export interface CrawlOptions {
  /** Base directory to crawl */
  baseDir: string;
  /** Include patterns (default: all .md files) */
  include?: string[];
  /** Exclude patterns (default: node_modules, .git, dist) */
  exclude?: string[];
  /** Follow symbolic links (default: false) */
  followSymlinks?: boolean;
}

/**
 * Options for ResourceRegistry constructor.
 */
export interface ResourceRegistryOptions {
  /** Validate resources when they are added (default: false) */
  validateOnAdd?: boolean;
}

/**
 * Statistics about resources in the registry.
 */
export interface RegistryStats {
  totalResources: number;
  totalLinks: number;
  linksByType: Record<string, number>;
}

/**
 * Resource registry for managing collections of markdown resources.
 *
 * Provides centralized management of markdown resources with:
 * - Automatic parsing and ID generation
 * - Link validation across the registry
 * - Link resolution between resources
 * - Query capabilities
 *
 * @example
 * ```typescript
 * const registry = new ResourceRegistry();
 *
 * // Add resources
 * await registry.addResource('/project/README.md');
 * await registry.crawl({ baseDir: '/project/docs' });
 *
 * // Validate all links
 * const result = await registry.validate();
 * console.log(`Found ${result.errorCount} errors`);
 *
 * // Resolve links between resources
 * registry.resolveLinks();
 *
 * // Query resources
 * const readme = registry.getResourceById('readme');
 * const docs = registry.getResourcesByPattern('docs/**');
 * ```
 */
export class ResourceRegistry {
  private resourcesByPath: Map<string, ResourceMetadata> = new Map();
  private resourcesById: Map<string, ResourceMetadata> = new Map();
  private validateOnAdd: boolean;

  constructor(options?: ResourceRegistryOptions) {
    this.validateOnAdd = options?.validateOnAdd ?? false;
  }

  /**
   * Add a single resource to the registry.
   *
   * Parses the markdown file, generates a unique ID, and stores the resource.
   * If validateOnAdd is true, validates the resource immediately.
   *
   * @param filePath - Path to the markdown file (will be normalized to absolute)
   * @returns The parsed resource metadata
   * @throws Error if file cannot be read or parsed
   *
   * @example
   * ```typescript
   * const resource = await registry.addResource('./docs/README.md');
   * console.log(`Added ${resource.id} with ${resource.links.length} links`);
   * ```
   */
  async addResource(filePath: string): Promise<ResourceMetadata> {
    // Normalize path to absolute
    const absolutePath = path.resolve(filePath);

    // Parse the markdown file
    const parseResult = await parseMarkdown(absolutePath);

    // Generate unique ID from file path
    const id = this.generateUniqueId(absolutePath);

    // Get file modified time
    const fs = await import('node:fs/promises');
    const stats = await fs.stat(absolutePath);

    // Create resource metadata
    const resource: ResourceMetadata = {
      id,
      filePath: absolutePath,
      links: parseResult.links,
      headings: parseResult.headings,
      sizeBytes: parseResult.sizeBytes,
      estimatedTokenCount: parseResult.estimatedTokenCount,
      modifiedAt: stats.mtime,
    };

    // Store in both maps
    this.resourcesByPath.set(absolutePath, resource);
    this.resourcesById.set(id, resource);

    // Validate if requested
    if (this.validateOnAdd) {
      const headingsByFile = this.buildHeadingsByFileMap();
      for (const link of resource.links) {
        const issue = await validateLink(link, absolutePath, headingsByFile);
        if (issue) {
          throw new Error(`Validation failed: ${issue.message}`);
        }
      }
    }

    return resource;
  }

  /**
   * Add multiple resources to the registry in parallel.
   *
   * @param filePaths - Array of file paths to add
   * @returns Array of parsed resource metadata
   *
   * @example
   * ```typescript
   * const resources = await registry.addResources([
   *   './README.md',
   *   './docs/guide.md',
   *   './docs/api.md'
   * ]);
   * ```
   */
  async addResources(filePaths: string[]): Promise<ResourceMetadata[]> {
    return await Promise.all(filePaths.map((fp) => this.addResource(fp)));
  }

  /**
   * Crawl a directory and add all matching markdown files.
   *
   * @param options - Crawl options (baseDir, include, exclude patterns)
   * @returns Array of all added resources
   *
   * @example
   * ```typescript
   * // Crawl docs directory, excluding node_modules
   * const resources = await registry.crawl({
   *   baseDir: './docs',
   *   include: ['**\/*.md'],
   *   exclude: ['**\/node_modules/**']
   * });
   * ```
   */
  async crawl(options: CrawlOptions): Promise<ResourceMetadata[]> {
    const {
      baseDir,
      include = ['**/*.md'],
      exclude = ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      followSymlinks = false,
    } = options;

    // Use utils file crawler
    const crawlOptions: UtilsCrawlOptions = {
      baseDir,
      include,
      exclude,
      followSymlinks,
      absolute: true,
      filesOnly: true,
    };

    const files = await crawlDirectory(crawlOptions);

    // Add all found files
    return await this.addResources(files);
  }

  /**
   * Validate all links in all resources in the registry.
   *
   * Checks:
   * - local_file links: file exists, anchor valid if present
   * - anchor links: heading exists in current file
   * - external links: returns info (not errors)
   * - email links: valid by default
   * - unknown links: returns warning
   *
   * @returns Validation result with all issues and statistics
   *
   * @example
   * ```typescript
   * const result = await registry.validate();
   * console.log(`Passed: ${result.passed}`);
   * console.log(`Errors: ${result.errorCount}`);
   * console.log(`Warnings: ${result.warningCount}`);
   * console.log(`Total resources: ${result.totalResources}`);
   * for (const issue of result.issues) {
   *   console.log(`${issue.severity}: ${issue.message}`);
   * }
   * ```
   */
  async validate(): Promise<ValidationResult> {
    const startTime = Date.now();

    // Build headings map for validation
    const headingsByFile = this.buildHeadingsByFileMap();

    // Collect all validation issues
    const issues: ValidationIssue[] = [];

    // Validate each link in each resource
    for (const resource of this.resourcesByPath.values()) {
      for (const link of resource.links) {
        const issue = await validateLink(link, resource.filePath, headingsByFile);
        if (issue) {
          issues.push(issue);
        }
      }
    }

    // Count issues by severity
    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const warningCount = issues.filter((i) => i.severity === 'warning').length;
    const infoCount = issues.filter((i) => i.severity === 'info').length;

    // Count links by type
    const linksByType: Record<string, number> = {};
    for (const resource of this.resourcesByPath.values()) {
      for (const link of resource.links) {
        linksByType[link.type] = (linksByType[link.type] ?? 0) + 1;
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      totalResources: this.resourcesByPath.size,
      totalLinks: [...this.resourcesByPath.values()].reduce(
        (sum, r) => sum + r.links.length,
        0
      ),
      linksByType,
      issues,
      errorCount,
      warningCount,
      infoCount,
      passed: errorCount === 0,
      durationMs,
      timestamp: new Date(),
    };
  }

  /**
   * Resolve links between resources in the registry.
   *
   * For each local_file link, sets the resolvedId property to the ID
   * of the target resource if it exists in the registry.
   *
   * Mutates the ResourceLink objects in place.
   *
   * @example
   * ```typescript
   * registry.resolveLinks();
   *
   * // Now local_file links have resolvedId set
   * const resource = registry.getResource('/project/README.md');
   * for (const link of resource.links) {
   *   if (link.type === 'local_file' && link.resolvedId) {
   *     console.log(`Link resolves to: ${link.resolvedId}`);
   *   }
   * }
   * ```
   */
  resolveLinks(): void {
    for (const resource of this.resourcesByPath.values()) {
      for (const link of resource.links) {
        if (link.type === 'local_file') {
          // Resolve the target file path
          const targetPath = this.resolveRelativeLinkPath(link.href, resource.filePath);

          // Look up resource by path
          const targetResource = this.resourcesByPath.get(targetPath);

          if (targetResource) {
            link.resolvedId = targetResource.id;
          }
        }
      }
    }
  }

  /**
   * Get a resource by its file path.
   *
   * @param filePath - Path to the resource (will be normalized to absolute)
   * @returns Resource metadata or undefined if not found
   *
   * @example
   * ```typescript
   * const resource = registry.getResource('./docs/README.md');
   * if (resource) {
   *   console.log(`Found: ${resource.id}`);
   * }
   * ```
   */
  getResource(filePath: string): ResourceMetadata | undefined {
    const absolutePath = path.resolve(filePath);
    return this.resourcesByPath.get(absolutePath);
  }

  /**
   * Get a resource by its ID.
   *
   * @param id - Resource ID
   * @returns Resource metadata or undefined if not found
   *
   * @example
   * ```typescript
   * const resource = registry.getResourceById('readme');
   * ```
   */
  getResourceById(id: string): ResourceMetadata | undefined {
    return this.resourcesById.get(id);
  }

  /**
   * Get all resources in the registry.
   *
   * @returns Array of all resource metadata
   *
   * @example
   * ```typescript
   * const allResources = registry.getAllResources();
   * console.log(`Total: ${allResources.length}`);
   * ```
   */
  getAllResources(): ResourceMetadata[] {
    return [...this.resourcesByPath.values()];
  }

  /**
   * Get resources matching a glob pattern.
   *
   * @param pattern - Glob pattern (e.g., 'docs/**', '**\/README.md')
   * @returns Array of matching resources
   *
   * @example
   * ```typescript
   * const docs = registry.getResourcesByPattern('docs/**');
   * const readmes = registry.getResourcesByPattern('**\/README.md');
   * ```
   */
  getResourcesByPattern(pattern: string): ResourceMetadata[] {
    const matcher = picomatch(pattern);
    return [...this.resourcesByPath.values()].filter((resource) =>
      matcher(resource.filePath)
    );
  }

  /**
   * Clear all resources from the registry.
   *
   * @example
   * ```typescript
   * registry.clear();
   * console.log(registry.getAllResources().length); // 0
   * ```
   */
  clear(): void {
    this.resourcesByPath.clear();
    this.resourcesById.clear();
  }

  /**
   * Get statistics about the resources in the registry.
   *
   * @returns Statistics object with counts
   *
   * @example
   * ```typescript
   * const stats = registry.getStats();
   * console.log(`Resources: ${stats.totalResources}`);
   * console.log(`Links: ${stats.totalLinks}`);
   * console.log(`Local file links: ${stats.linksByType.local_file}`);
   * ```
   */
  getStats(): RegistryStats {
    const totalResources = this.resourcesByPath.size;
    let totalLinks = 0;
    const linksByType: Record<string, number> = {};

    for (const resource of this.resourcesByPath.values()) {
      totalLinks += resource.links.length;
      for (const link of resource.links) {
        linksByType[link.type] = (linksByType[link.type] ?? 0) + 1;
      }
    }

    return {
      totalResources,
      totalLinks,
      linksByType,
    };
  }

  /**
   * Generate a unique ID from a file path.
   *
   * Process:
   * 1. Get basename without extension
   * 2. Convert to kebab-case
   * 3. Handle collisions by appending suffix (-2, -3, etc.)
   *
   * @param filePath - Absolute file path
   * @returns Unique ID
   */
  private generateUniqueId(filePath: string): string {
    const baseId = generateIdFromPath(filePath);

    // Check for collision
    if (!this.resourcesById.has(baseId)) {
      return baseId;
    }

    // Handle collision by appending suffix
    let suffix = 2;
    while (this.resourcesById.has(`${baseId}-${suffix}`)) {
      suffix++;
    }

    return `${baseId}-${suffix}`;
  }

  /**
   * Build a map of file paths to their heading trees.
   *
   * Used for link validation.
   */
  private buildHeadingsByFileMap(): Map<string, HeadingNode[]> {
    const map = new Map<string, HeadingNode[]>();
    for (const resource of this.resourcesByPath.values()) {
      map.set(resource.filePath, resource.headings);
    }
    return map;
  }

  /**
   * Resolve a relative link href to an absolute file path.
   *
   * @param linkHref - The href from the link (e.g., './file.md', '../dir/file.md#anchor')
   * @param sourceFilePath - Absolute path to the source file
   * @returns Absolute path to the target file
   */
  private resolveRelativeLinkPath(linkHref: string, sourceFilePath: string): string {
    // Strip anchor if present
    const [filePath] = splitHrefAnchor(linkHref);

    // Resolve relative to source file's directory
    const sourceDir = path.dirname(sourceFilePath);
    return path.resolve(sourceDir, filePath);
  }
}

/**
 * Generate an ID from a file path.
 *
 * Process:
 * 1. Remove extension (.md)
 * 2. Get basename
 * 3. Convert to kebab-case
 * 4. Remove non-alphanumeric characters except hyphens
 *
 * @param filePath - File path
 * @returns Generated ID (not yet checked for uniqueness)
 *
 * @example
 * ```typescript
 * generateIdFromPath('/project/docs/User Guide.md')  // 'user-guide'
 * generateIdFromPath('/project/README.md')           // 'readme'
 * generateIdFromPath('/project/docs/API_v2.md')      // 'api-v2'
 * ```
 */
function generateIdFromPath(filePath: string): string {
  // Get basename without extension
  const basename = path.basename(filePath, path.extname(filePath));

  // Convert to kebab-case:
  // 1. Replace underscores and spaces with hyphens
  // 2. Convert to lowercase
  // 3. Remove non-alphanumeric except hyphens
  // 4. Collapse multiple hyphens
  return basename
    .replaceAll(/[_\s]+/g, '-')
    .toLowerCase()
    .replaceAll(/[^\da-z-]/g, '')
    .replaceAll(/-{2,}/g, '-') // Collapse multiple hyphens (2 or more)
    .replace(/^-/, '') // Trim leading hyphen
    .replace(/-$/, ''); // Trim trailing hyphen
}


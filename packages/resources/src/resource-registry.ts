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

import { calculateChecksum } from './checksum.js';
import { validateFrontmatter } from './frontmatter-validator.js';
import { parseMarkdown } from './link-parser.js';
import { validateLink } from './link-validator.js';
import type { ResourceCollectionInterface } from './resource-collection-interface.js';
import type { SHA256 } from './schemas/checksum.js';
import type { HeadingNode, ResourceMetadata } from './schemas/resource-metadata.js';
import type { ValidationIssue, ValidationResult } from './schemas/validation-result.js';
import { matchesGlobPattern, splitHrefAnchor } from './utils.js';

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
  /** Root directory for resources (optional) */
  rootDir?: string;
  /** Validate resources when they are added (default: false) */
  validateOnAdd?: boolean;
}

/**
 * Options for validate method.
 */
export interface ValidateOptions {
  /** Optional JSON Schema to validate frontmatter against */
  frontmatterSchema?: object;
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
export class ResourceRegistry implements ResourceCollectionInterface {
  /** Optional root directory for resources */
  readonly rootDir?: string;

  private readonly resourcesByPath: Map<string, ResourceMetadata> = new Map();
  private readonly resourcesById: Map<string, ResourceMetadata> = new Map();
  private readonly resourcesByName: Map<string, ResourceMetadata[]> = new Map();
  private readonly resourcesByChecksum: Map<SHA256, ResourceMetadata[]> = new Map();
  private readonly validateOnAdd: boolean;

  constructor(options?: ResourceRegistryOptions) {
    if (options?.rootDir !== undefined) {
      this.rootDir = options.rootDir;
    }
    this.validateOnAdd = options?.validateOnAdd ?? false;
  }

  /**
   * Create an empty registry with a root directory.
   *
   * @param rootDir - Root directory for resources
   * @param options - Additional options
   * @returns New empty registry
   *
   * @example
   * ```typescript
   * const registry = ResourceRegistry.empty('/project/docs');
   * console.log(registry.rootDir); // '/project/docs'
   * console.log(registry.size()); // 0
   * ```
   */
  static empty(rootDir: string, options?: Omit<ResourceRegistryOptions, 'rootDir'>): ResourceRegistry {
    return new ResourceRegistry({ ...options, rootDir });
  }

  /**
   * Create a registry from an existing array of resources.
   *
   * Initializes all indexes (by path, ID, name, checksum) from the provided resources.
   *
   * @param rootDir - Root directory for resources
   * @param resources - Array of resource metadata
   * @param options - Additional options
   * @returns New registry with resources
   *
   * @example
   * ```typescript
   * const resources = [resource1, resource2];
   * const registry = ResourceRegistry.fromResources('/project', resources);
   * console.log(`Created registry with ${registry.size()} resources`);
   * ```
   */
  static fromResources(
    rootDir: string,
    resources: ResourceMetadata[],
    options?: Omit<ResourceRegistryOptions, 'rootDir'>,
  ): ResourceRegistry {
    const registry = new ResourceRegistry({ ...options, rootDir });

    // Add all resources to indexes
    for (const resource of resources) {
      // Add to path index
      registry.resourcesByPath.set(resource.filePath, resource);

      // Add to ID index
      registry.resourcesById.set(resource.id, resource);

      // Add to name index
      const filename = path.basename(resource.filePath);
      const existingByName = registry.resourcesByName.get(filename) ?? [];
      registry.resourcesByName.set(filename, [...existingByName, resource]);

      // Add to checksum index
      const existingByChecksum = registry.resourcesByChecksum.get(resource.checksum) ?? [];
      registry.resourcesByChecksum.set(resource.checksum, [...existingByChecksum, resource]);
    }

    return registry;
  }

  /**
   * Create a registry by crawling a directory.
   *
   * Combines registry creation and directory crawling in a single operation.
   *
   * @param crawlOptions - Crawl options including baseDir
   * @param registryOptions - Additional registry options
   * @returns New registry with crawled resources
   *
   * @example
   * ```typescript
   * const registry = await ResourceRegistry.fromCrawl({
   *   baseDir: '/project/docs',
   *   include: ['**.md'],
   *   exclude: ['node_modules'],
   * });
   * console.log(`Crawled ${registry.size()} resources`);
   * ```
   */
  static async fromCrawl(
    crawlOptions: CrawlOptions,
    registryOptions?: Omit<ResourceRegistryOptions, 'rootDir'>,
  ): Promise<ResourceRegistry> {
    const registry = new ResourceRegistry({ ...registryOptions, rootDir: crawlOptions.baseDir });
    await registry.crawl(crawlOptions);
    return registry;
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

    // Calculate checksum eagerly
    const checksum = await calculateChecksum(absolutePath);

    // Create resource metadata
    const resource: ResourceMetadata = {
      id,
      filePath: absolutePath,
      links: parseResult.links,
      headings: parseResult.headings,
      ...(parseResult.frontmatter !== undefined && { frontmatter: parseResult.frontmatter }),
      ...(parseResult.frontmatterError !== undefined && { frontmatterError: parseResult.frontmatterError }),
      sizeBytes: parseResult.sizeBytes,
      estimatedTokenCount: parseResult.estimatedTokenCount,
      modifiedAt: stats.mtime,
      checksum,
    };

    // Index the resource
    this.indexResource(resource);

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
   * Validate all links and optionally frontmatter in all resources in the registry.
   *
   * Checks:
   * - local_file links: file exists, anchor valid if present
   * - anchor links: heading exists in current file
   * - external links: returns info (not errors)
   * - email links: valid by default
   * - unknown links: returns warning
   * - frontmatter: validates against JSON Schema if provided
   *
   * @param options - Validation options (optional)
   * @returns Validation result with all issues and statistics
   *
   * @example
   * ```typescript
   * // Validate links only
   * const result = await registry.validate();
   *
   * // Validate links and frontmatter
   * const schema = { type: 'object', required: ['title'] };
   * const result = await registry.validate({ frontmatterSchema: schema });
   *
   * console.log(`Passed: ${result.passed}`);
   * console.log(`Errors: ${result.errorCount}`);
   * console.log(`Warnings: ${result.warningCount}`);
   * console.log(`Total resources: ${result.totalResources}`);
   * for (const issue of result.issues) {
   *   console.log(`${issue.severity}: ${issue.message}`);
   * }
   * ```
   */
  async validate(options?: ValidateOptions): Promise<ValidationResult> {
    const startTime = Date.now();

    // Build headings map for validation
    const headingsByFile = this.buildHeadingsByFileMap();

    // Collect all validation issues
    const issues: ValidationIssue[] = [];

    // Check for YAML parsing errors first
    for (const resource of this.resourcesByPath.values()) {
      if (resource.frontmatterError) {
        issues.push({
          severity: 'error',
          resourcePath: resource.filePath,
          line: 1,
          type: 'frontmatter_invalid_yaml',
          link: '',
          message: `Invalid YAML syntax in frontmatter: ${resource.frontmatterError}`,
        });
      }
    }

    // Validate each link in each resource
    for (const resource of this.resourcesByPath.values()) {
      for (const link of resource.links) {
        const issue = await validateLink(link, resource.filePath, headingsByFile);
        if (issue) {
          issues.push(issue);
        }
      }
    }

    // Frontmatter validation (if schema provided)
    if (options?.frontmatterSchema) {
      for (const resource of this.resourcesByPath.values()) {
        const frontmatterIssues = validateFrontmatter(
          resource.frontmatter,
          options.frontmatterSchema,
          resource.filePath
        );
        issues.push(...frontmatterIssues);
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
   * Get resources by filename (basename).
   *
   * Returns all resources with the given filename, regardless of directory.
   * Useful for finding duplicate filenames or locating files by name.
   *
   * @param name - Filename to search for (e.g., 'README.md')
   * @returns Array of resources with matching filename (empty if none found)
   *
   * @example
   * ```typescript
   * // Find all README.md files
   * const readmes = registry.getResourcesByName('README.md');
   * console.log(`Found ${readmes.length} README files`);
   * ```
   */
  getResourcesByName(name: string): ResourceMetadata[] {
    return this.resourcesByName.get(name) ?? [];
  }

  /**
   * Get resources by checksum.
   *
   * Returns all resources with identical content (same SHA-256 hash).
   * Useful for detecting duplicate content across different files.
   *
   * @param checksum - SHA-256 checksum to search for
   * @returns Array of resources with matching checksum (empty if none found)
   *
   * @example
   * ```typescript
   * const resource = registry.getResource('./docs/README.md');
   * const duplicates = registry.getResourcesByChecksum(resource.checksum);
   * if (duplicates.length > 1) {
   *   console.log('Found duplicate content in:');
   *   duplicates.forEach(r => console.log(`  ${r.filePath}`));
   * }
   * ```
   */
  getResourcesByChecksum(checksum: SHA256): ResourceMetadata[] {
    return this.resourcesByChecksum.get(checksum) ?? [];
  }

  /**
   * Get resources matching a glob pattern.
   *
   * Normalizes paths to Unix-style (forward slashes) before matching
   * to ensure consistent behavior across platforms. On Windows,
   * path.resolve() returns backslashes but glob patterns expect forward slashes.
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
    return [...this.resourcesByPath.values()].filter((resource) =>
      matchesGlobPattern(resource.filePath, pattern)
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
    this.resourcesByName.clear();
    this.resourcesByChecksum.clear();
  }

  /**
   * Get the number of resources in the registry.
   *
   * @returns Number of resources
   *
   * @example
   * ```typescript
   * console.log(`Registry has ${registry.size()} resources`);
   * ```
   */
  size(): number {
    return this.resourcesByPath.size;
  }

  /**
   * Check if the registry is empty.
   *
   * @returns True if the registry has no resources
   *
   * @example
   * ```typescript
   * if (registry.isEmpty()) {
   *   console.log('No resources yet');
   * }
   * ```
   */
  isEmpty(): boolean {
    return this.resourcesByPath.size === 0;
  }

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
   * const duplicates = registry.getDuplicates();
   * for (const group of duplicates) {
   *   console.log(`Found ${group.length} duplicates:`);
   *   for (const resource of group) {
   *     console.log(`  - ${resource.filePath}`);
   *   }
   * }
   * ```
   */
  getDuplicates(): ResourceMetadata[][] {
    const duplicateGroups: ResourceMetadata[][] = [];
    for (const group of this.resourcesByChecksum.values()) {
      if (group.length >= 2) {
        duplicateGroups.push(group);
      }
    }
    return duplicateGroups;
  }

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
   * const unique = registry.getUniqueByChecksum();
   * console.log(`${unique.length} unique resources by content`);
   * ```
   */
  getUniqueByChecksum(): ResourceMetadata[] {
    const unique: ResourceMetadata[] = [];
    for (const group of this.resourcesByChecksum.values()) {
      if (group[0]) {
        unique.push(group[0]);
      }
    }
    return unique;
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
   * Add a resource to all indexes.
   *
   * Indexes maintained:
   * - byPath: Single resource per absolute path (Map)
   * - byId: Single resource per unique ID (Map)
   * - byName: Multiple resources per filename (Map<string, Array>)
   * - byChecksum: Multiple resources per content hash (Map<SHA256, Array>)
   *
   * @param resource - Resource to index
   */
  private indexResource(resource: ResourceMetadata): void {
    // Index by path (1:1)
    this.resourcesByPath.set(resource.filePath, resource);

    // Index by ID (1:1)
    this.resourcesById.set(resource.id, resource);

    // Index by name (1:many)
    const name = path.basename(resource.filePath);
    const nameArray = this.resourcesByName.get(name);
    if (nameArray) {
      nameArray.push(resource);
    } else {
      this.resourcesByName.set(name, [resource]);
    }

    // Index by checksum (1:many)
    const checksumArray = this.resourcesByChecksum.get(resource.checksum);
    if (checksumArray) {
      checksumArray.push(resource);
    } else {
      this.resourcesByChecksum.set(resource.checksum, [resource]);
    }
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


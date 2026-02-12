/**
 * Resource registry for managing collections of markdown resources.
 *
 * The registry maintains a collection of parsed markdown resources and provides:
 * - Resource addition and crawling
 * - Link validation across the registry
 * - Link resolution (setting resolvedId for local_file links)
 * - Query capabilities (by path, ID, or glob pattern)
 */

import type fs from 'node:fs/promises';
import path from 'node:path';

import { crawlDirectory, type CrawlOptions as UtilsCrawlOptions, type GitTracker, normalizedTmpdir, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { calculateChecksum } from './checksum.js';
import { getCollectionsForFile } from './collection-matcher.js';
import { ExternalLinkValidator } from './external-link-validator.js';
import { validateFrontmatter } from './frontmatter-validator.js';
import { parseMarkdown } from './link-parser.js';
import { validateLink } from './link-validator.js';
import type { ResourceCollectionInterface } from './resource-collection-interface.js';
import type { SHA256 } from './schemas/checksum.js';
import type { ProjectConfig } from './schemas/project-config.js';
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
  /** Base directory for resources. Used for relative-path ID generation and schema resolution. */
  baseDir?: string;
  /** Frontmatter field name to use as resource ID (optional). When set, the value of this frontmatter field takes priority over path-based ID generation. */
  idField?: string;
  /** Project configuration (optional, enables collection support) */
  config?: ProjectConfig;
  /** Git tracker for efficient git-ignore checking (optional, improves performance) */
  gitTracker?: GitTracker;
}

/**
 * Options for validate method.
 */
export interface ValidateOptions {
  /** Optional JSON Schema to validate frontmatter against */
  frontmatterSchema?: object;
  /** Skip git-ignore checks (default: false) */
  skipGitIgnoreCheck?: boolean;
  /** Validation mode for schemas: strict (default) or permissive */
  validationMode?: 'strict' | 'permissive';
  /** Check external URLs for validity (default: false) */
  checkExternalUrls?: boolean;
  /** Disable cache for external URL checks (default: false) */
  noCache?: boolean;
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
 * Statistics for a single collection.
 */
export interface CollectionStat {
  /** Number of resources in this collection */
  resourceCount: number;
  /** Whether this collection has a frontmatter schema configured */
  hasSchema: boolean;
  /** Validation mode for this collection's schema */
  validationMode?: 'strict' | 'permissive';
}

/**
 * Statistics about all collections in the registry.
 */
export interface CollectionStats {
  /** Total number of configured collections */
  totalCollections: number;
  /** Total number of resources that belong to at least one collection */
  resourcesInCollections: number;
  /** Statistics per collection ID */
  collections: Record<string, CollectionStat>;
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
  /** Base directory for resources. Used for relative-path ID generation and schema resolution. */
  readonly baseDir?: string;

  /** Frontmatter field name to use as resource ID. */
  readonly idField?: string;

  /** Optional project configuration (enables collection support) */
  readonly config?: ProjectConfig;

  /** Optional git tracker for efficient git-ignore checking */
  readonly gitTracker?: GitTracker;

  private readonly resourcesByPath: Map<string, ResourceMetadata> = new Map();
  private readonly resourcesById: Map<string, ResourceMetadata> = new Map();
  private readonly resourcesByName: Map<string, ResourceMetadata[]> = new Map();
  private readonly resourcesByChecksum: Map<SHA256, ResourceMetadata[]> = new Map();

  constructor(options?: ResourceRegistryOptions) {
    if (options?.baseDir !== undefined) {
      this.baseDir = options.baseDir;
    }
    if (options?.idField !== undefined) {
      this.idField = options.idField;
    }
    if (options?.config !== undefined) {
      this.config = options.config;
    }
    if (options?.gitTracker !== undefined) {
      this.gitTracker = options.gitTracker;
    }
  }

  /**
   * Create an empty registry with a base directory.
   *
   * @param baseDir - Base directory for resources
   * @param options - Additional options
   * @returns New empty registry
   *
   * @example
   * ```typescript
   * const registry = ResourceRegistry.empty('/project/docs');
   * console.log(registry.baseDir); // '/project/docs'
   * console.log(registry.size()); // 0
   * ```
   */
  static empty(baseDir: string, options?: Omit<ResourceRegistryOptions, 'baseDir'>): ResourceRegistry {
    return new ResourceRegistry({ ...options, baseDir });
  }

  /**
   * Create a registry from an existing array of resources.
   *
   * Initializes all indexes (by path, ID, name, checksum) from the provided resources.
   * Throws if any resources have duplicate IDs.
   *
   * @param baseDir - Base directory for resources
   * @param resources - Array of resource metadata
   * @param options - Additional options
   * @returns New registry with resources
   * @throws Error if duplicate resource IDs are found
   *
   * @example
   * ```typescript
   * const resources = [resource1, resource2];
   * const registry = ResourceRegistry.fromResources('/project', resources);
   * console.log(`Created registry with ${registry.size()} resources`);
   * ```
   */
  static fromResources(
    baseDir: string,
    resources: ResourceMetadata[],
    options?: Omit<ResourceRegistryOptions, 'baseDir'>,
  ): ResourceRegistry {
    const registry = new ResourceRegistry({ ...options, baseDir });

    // Add all resources to indexes
    for (const resource of resources) {
      // Check for duplicate ID
      const existingById = registry.resourcesById.get(resource.id);
      if (existingById) {
        throw new Error(
          `Duplicate resource ID '${resource.id}': '${resource.filePath}' conflicts with '${existingById.filePath}'`
        );
      }

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
    registryOptions?: Omit<ResourceRegistryOptions, 'baseDir'>,
  ): Promise<ResourceRegistry> {
    const registry = new ResourceRegistry({ ...registryOptions, baseDir: crawlOptions.baseDir });
    await registry.crawl(crawlOptions);
    return registry;
  }

  /**
   * Add a single resource to the registry.
   *
   * Parses the markdown file, generates a unique ID, and stores the resource.
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

    // Parse the markdown file (needed before ID generation for frontmatter lookup)
    const parseResult = await parseMarkdown(absolutePath);

    // Generate ID using priority chain: frontmatter field → relative path → filename stem
    const id = this.generateId(absolutePath, parseResult.frontmatter);

    // Check for duplicate ID (allow re-adding same file path)
    const existingById = this.resourcesById.get(id);
    if (existingById && existingById.filePath !== absolutePath) {
      throw new Error(
        `Duplicate resource ID '${id}': '${absolutePath}' conflicts with '${existingById.filePath}'`
      );
    }

    // Get file modified time
    const fs = await import('node:fs/promises');
    const stats = await fs.stat(absolutePath);

    // Calculate checksum eagerly
    const checksum = await calculateChecksum(absolutePath);

    // Determine collections if config is present
    const collections = this.config?.resources?.collections
      ? getCollectionsForFile(absolutePath, this.config.resources.collections)
      : undefined;

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
      ...(collections !== undefined && collections.length > 0 && { collections }),
    };

    // Index the resource
    this.indexResource(resource);

    return resource;
  }

  /**
   * Add multiple resources to the registry sequentially.
   *
   * Sequential execution ensures deterministic duplicate ID detection.
   *
   * @param filePaths - Array of file paths to add
   * @returns Array of parsed resource metadata
   * @throws Error if any resource produces a duplicate ID
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
    const results: ResourceMetadata[] = [];
    for (const fp of filePaths) {
      results.push(await this.addResource(fp));
    }
    return results;
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
   * Check for YAML parsing errors in all resources.
   * @private
   */
  private collectYamlErrors(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const resource of this.resourcesByPath.values()) {
      if (resource.frontmatterError) {
        issues.push({
          resourcePath: resource.filePath,
          line: 1,
          type: 'frontmatter_invalid_yaml',
          link: '',
          message: `Invalid YAML syntax in frontmatter: ${resource.frontmatterError}`,
        });
      }
    }
    return issues;
  }

  /**
   * Validate all links in all resources.
   * @private
   */
  private async validateAllLinks(
    headingsByFile: Map<string, HeadingNode[]>,
    skipGitIgnoreCheck: boolean
  ): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    for (const resource of this.resourcesByPath.values()) {
      for (const link of resource.links) {
        // Only pass options if projectRoot is defined (exactOptionalPropertyTypes requirement)
        const validateOptions = this.baseDir === undefined
          ? { skipGitIgnoreCheck }
          : {
              projectRoot: this.baseDir,
              skipGitIgnoreCheck,
              ...(this.gitTracker !== undefined && { gitTracker: this.gitTracker })
            };

        const issue = await validateLink(link, resource.filePath, headingsByFile, validateOptions);
        if (issue) {
          issues.push(issue);
        }
      }
    }

    return issues;
  }

  /**
   * Validate frontmatter against a JSON Schema.
   * @private
   */
  private validateAllFrontmatter(
    schema: object,
    mode: 'strict' | 'permissive' = 'strict'
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const resource of this.resourcesByPath.values()) {
      const frontmatterIssues = validateFrontmatter(
        resource.frontmatter,
        schema,
        resource.filePath,
        mode
      );
      issues.push(...frontmatterIssues);
    }
    return issues;
  }

  /**
   * Validate frontmatter against per-collection schemas.
   * @private
   */
  private async validateCollectionFrontmatter(): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    // Skip if no config
    if (!this.config?.resources?.collections) {
      return issues;
    }

    const fsPromises = await import('node:fs/promises');

    for (const resource of this.resourcesByPath.values()) {
      // Skip if resource has no collections
      if (!resource.collections || resource.collections.length === 0) {
        continue;
      }

      // Validate against each collection's schema
      const collectionIssues = await this.validateResourceCollectionSchemas(
        resource,
        fsPromises
      );
      issues.push(...collectionIssues);
    }

    return issues;
  }

  /**
   * Validate a single resource against its collection schemas.
   * @private
   */
  private async validateResourceCollectionSchemas(
    resource: ResourceMetadata,
    fsModule: typeof fs
  ): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    if (!resource.collections || !this.config?.resources?.collections) {
      return issues;
    }

    for (const collectionId of resource.collections) {
      const collection = this.config.resources.collections[collectionId];

      // Skip if collection has no validation or no schema
      if (!collection?.validation?.frontmatterSchema) {
        continue;
      }

      const collectionIssues = await this.validateAgainstCollectionSchema(
        resource,
        collection.validation,
        fsModule
      );
      issues.push(...collectionIssues);
    }

    return issues;
  }

  /**
   * Validate resource frontmatter against a specific collection schema.
   * @private
   */
  private async validateAgainstCollectionSchema(
    resource: ResourceMetadata,
    validation: NonNullable<ProjectConfig['resources']>['collections'][string]['validation'],
    fsModule: typeof fs
  ): Promise<ValidationIssue[]> {
    if (!validation?.frontmatterSchema) {
      return [];
    }

    const schemaPath = path.resolve(
      this.baseDir ?? process.cwd(),
      validation.frontmatterSchema
    );

    try {
      const schemaContent = await fsModule.readFile(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent) as object;

      // Determine validation mode (default to permissive)
      const mode = validation.mode ?? 'permissive';

      // Validate frontmatter
      return validateFrontmatter(
        resource.frontmatter,
        schema,
        resource.filePath,
        mode,
        schemaPath
      );
    } catch (error) {
      // Handle missing or invalid schema files gracefully
      const errorMessage = error instanceof Error ? error.message : String(error);
      return [{
        resourcePath: resource.filePath,
        line: 1,
        type: 'frontmatter_schema_error',
        link: '',
        message: `Failed to load or parse frontmatter schema '${validation.frontmatterSchema}': ${errorMessage}`,
      }];
    }
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
   * console.log(`Total resources: ${result.totalResources}`);
   * for (const issue of result.issues) {
   *   console.log(`${issue.message}`);
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
    issues.push(...this.collectYamlErrors());

    // Validate each link in each resource
    const linkIssues = await this.validateAllLinks(
      headingsByFile,
      options?.skipGitIgnoreCheck ?? false
    );
    issues.push(...linkIssues);

    // Per-collection frontmatter validation
    const collectionFrontmatterIssues = await this.validateCollectionFrontmatter();
    issues.push(...collectionFrontmatterIssues);

    // Global frontmatter validation (if schema provided)
    if (options?.frontmatterSchema) {
      const mode = options.validationMode ?? 'strict';
      issues.push(...this.validateAllFrontmatter(options.frontmatterSchema, mode));
    }

    // External URL validation (if enabled)
    if (options?.checkExternalUrls) {
      const externalUrlIssues = await this.validateExternalUrls(options.noCache ?? false);
      issues.push(...externalUrlIssues);
    }

    // Count issues (all are errors now)
    const errorCount = issues.length;

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
      passed: errorCount === 0,
      durationMs,
      timestamp: new Date(),
    };
  }

  /**
   * Validate external URLs in all resources.
   * @private
   */
  private async validateExternalUrls(noCache: boolean): Promise<ValidationIssue[]> {
    // Determine cache directory
    const cacheDir = this.getCacheDirectory();

    // Create validator
    const validator = new ExternalLinkValidator(cacheDir, {
      timeout: 15000,
      cacheTtlHours: noCache ? 0 : 24,
    });

    // Collect all external URLs from all resources
    const urlsToValidate = this.collectExternalUrls();

    // Validate all unique URLs
    const uniqueUrls = [...urlsToValidate.keys()];
    const results = await validator.validateLinks(uniqueUrls);

    // Convert validation results to issues
    return this.convertValidationResultsToIssues(results, urlsToValidate);
  }

  /**
   * Get cache directory for external URL validation.
   *
   * Always uses system temp directory (not project directory) because:
   * - URL validation results are universal (not project-specific)
   * - Avoids polluting project directories
   * - No .gitignore entry needed
   * - OS handles cleanup automatically
   * - Cache shared across all projects (more efficient)
   *
   * @private
   */
  private getCacheDirectory(): string {
    return path.join(normalizedTmpdir(), '.vat-cache');
  }

  /**
   * Collect all external URLs from all resources.
   * @private
   */
  private collectExternalUrls(): Map<string, Array<{ resourcePath: string; line?: number }>> {
    const urlsToValidate = new Map<string, Array<{ resourcePath: string; line?: number }>>();

    for (const resource of this.resourcesByPath.values()) {
      for (const link of resource.links) {
        if (link.type === 'external') {
          const locations = urlsToValidate.get(link.href) ?? [];
          const location: { resourcePath: string; line?: number } = {
            resourcePath: resource.filePath,
          };
          if (link.line !== undefined) {
            location.line = link.line;
          }
          locations.push(location);
          urlsToValidate.set(link.href, locations);
        }
      }
    }

    return urlsToValidate;
  }

  /**
   * Convert validation results to validation issues.
   * @private
   */
  private convertValidationResultsToIssues(
    results: Array<{ url: string; status: 'ok' | 'error'; statusCode: number; error?: string }>,
    urlsToValidate: Map<string, Array<{ resourcePath: string; line?: number }>>,
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const result of results) {
      if (result.status !== 'error') {
        continue;
      }

      const locations = urlsToValidate.get(result.url);
      if (!locations) {
        continue;
      }

      const issueType = this.determineExternalUrlIssueType(result.statusCode, result.error);
      const errorMessage = result.error ?? `HTTP ${result.statusCode}`;

      for (const location of locations) {
        issues.push({
          resourcePath: location.resourcePath,
          line: location.line,
          type: issueType,
          link: result.url,
          message: `External URL failed: ${errorMessage}`,
        });
      }
    }

    return issues;
  }

  /**
   * Determine issue type based on validation error.
   * @private
   */
  private determineExternalUrlIssueType(statusCode: number, error?: string): string {
    if (statusCode === 0) {
      const errorLower = error?.toString().toLowerCase();
      if (errorLower?.includes('timeout')) {
        return 'external_url_timeout';
      }
      return 'external_url_error';
    }
    return 'external_url_dead';
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
   * Get collection-level statistics.
   *
   * Returns undefined if collections are not configured in the project config.
   *
   * @returns Collection statistics or undefined if no collections configured
   *
   * @example
   * ```typescript
   * const collectionStats = registry.getCollectionStats();
   * if (collectionStats) {
   *   console.log(`Total collections: ${collectionStats.totalCollections}`);
   *   console.log(`Resources in collections: ${collectionStats.resourcesInCollections}`);
   *   for (const [id, stat] of Object.entries(collectionStats.collections)) {
   *     console.log(`${id}: ${stat.resourceCount} resources`);
   *   }
   * }
   * ```
   */
  getCollectionStats(): CollectionStats | undefined {
    if (!this.config?.resources?.collections) {
      return undefined;
    }

    // Group resources by collection
    const collectionMap = new Map<string, ResourceMetadata[]>();

    for (const resource of this.resourcesByPath.values()) {
      if (resource.collections) {
        for (const collectionId of resource.collections) {
          const resources = collectionMap.get(collectionId) ?? [];
          resources.push(resource);
          collectionMap.set(collectionId, resources);
        }
      }
    }

    // Build stats per collection
    const collections: Record<string, CollectionStat> = {};

    for (const [id, resources] of collectionMap.entries()) {
      const collection = this.config.resources.collections[id];
      const stat: CollectionStat = {
        resourceCount: resources.length,
        hasSchema: !!collection?.validation?.frontmatterSchema,
      };

      // Only add validationMode if it's defined (exactOptionalPropertyTypes requirement)
      if (collection?.validation?.mode !== undefined) {
        stat.validationMode = collection.validation.mode;
      }

      collections[id] = stat;
    }

    // Calculate total unique resources in collections (a resource may be in multiple collections)
    const uniqueResourcesInCollections = new Set<string>();
    for (const resource of this.resourcesByPath.values()) {
      if (resource.collections && resource.collections.length > 0) {
        uniqueResourcesInCollections.add(resource.filePath);
      }
    }

    return {
      totalCollections: Object.keys(this.config.resources.collections).length,
      resourcesInCollections: uniqueResourcesInCollections.size,
      collections,
    };
  }

  /**
   * Generate a resource ID using the priority chain:
   * 1. Frontmatter field (if `idField` is configured and field exists)
   * 2. Relative path from `baseDir` (if `baseDir` is set)
   * 3. Filename stem (fallback)
   *
   * @param filePath - Absolute file path
   * @param frontmatter - Parsed frontmatter (optional)
   * @returns Resource ID
   */
  private generateId(filePath: string, frontmatter?: Record<string, unknown>): string {
    // Priority 1: Frontmatter field
    if (this.idField && frontmatter?.[this.idField] !== undefined) {
      return String(frontmatter[this.idField]);
    }

    // Priority 2/3: Path-based (relative to baseDir, or filename stem)
    return generateIdFromPath(filePath, this.baseDir);
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
 * When `baseDir` is provided, computes a relative path from baseDir and uses the full
 * directory structure in the ID. When no `baseDir`, uses the filename stem only.
 *
 * @param filePath - Absolute file path
 * @param baseDir - Base directory for relative path computation (optional)
 * @returns Generated ID in kebab-case
 *
 * @example
 * ```typescript
 * // Without baseDir: filename stem only
 * generateIdFromPath('/project/docs/User Guide.md')  // 'user-guide'
 * generateIdFromPath('/project/README.md')            // 'readme'
 *
 * // With baseDir: relative path
 * generateIdFromPath('/project/docs/concepts/core/overview.md', '/project/docs')  // 'concepts-core-overview'
 * generateIdFromPath('/project/docs/guide.md', '/project/docs')                   // 'guide'
 * ```
 */
export function generateIdFromPath(filePath: string, baseDir?: string): string {
  let rawId: string;

  if (baseDir) {
    // Compute relative path from baseDir, remove extension
    const relativePath = path.relative(baseDir, filePath);
    const ext = path.extname(relativePath);
    const withoutExt = ext ? relativePath.slice(0, -ext.length) : relativePath;
    // Normalize path separators to forward slashes (cross-platform), then replace with hyphens
    rawId = toForwardSlash(withoutExt).replaceAll('/', '-');
  } else {
    // Fallback: basename only (no directory context)
    rawId = path.basename(filePath, path.extname(filePath));
  }

  // Convert to kebab-case:
  // 1. Replace underscores and spaces with hyphens
  // 2. Convert to lowercase
  // 3. Remove non-alphanumeric except hyphens
  // 4. Collapse multiple hyphens
  return rawId
    .replaceAll(/[_\s]+/g, '-')
    .toLowerCase()
    .replaceAll(/[^\da-z-]/g, '')
    .replaceAll(/-{2,}/g, '-') // Collapse multiple hyphens (2 or more)
    .replace(/^-/, '') // Trim leading hyphen
    .replace(/-$/, ''); // Trim trailing hyphen
}


/**
 * Resource registry for managing collections of markdown resources.
 *
 * The registry maintains a collection of parsed markdown resources and provides:
 * - Resource addition and crawling
 * - Link validation across the registry
 * - Link resolution (setting resolvedId for local_file links)
 * - Query capabilities (by path, ID, or glob pattern)
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { createRegistryIssue, type IssueCode, runSingleUnitValidation, type ValidationConfig, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { CRAWL_REGISTRY_ADD_RESOURCE_ID, CRAWL_REGISTRY_ENUMERATE_ID, CRAWL_REGISTRY_RESOLVE_LINKS_ID, crawlDirectory, type CrawlOptions as UtilsCrawlOptions, crawlPathFilter, crawlTimingStart, FsLookupCache, type GitTracker, issueLocation, recordRegistryPass, resolveAssetReference, safePath, toForwardSlash, toNfc, withOuterBracket } from '@vibe-agent-toolkit/utils';
import { decodeTextContent } from '@vibe-agent-toolkit/utils/text';

import { calculateChecksumFromContent } from './checksum.js';
import { getCollectionsForFile } from './collection-matcher.js';
import { parserKindForPath, readContentWithKey } from './content-key.js';
import type { DeferredArtifacts } from './deferred-artifacts.js';
import {
  validateFrontmatterLinks,
  type FrontmatterExternalUrl,
} from './frontmatter-link-validator.js';
import {
  compileFrontmatterSchema,
  validateCompiledFrontmatter,
  type CompiledFrontmatterSchema,
} from './frontmatter-validator.js';
import { buildLinkAuthEngineConfig } from './link-auth-config-build.js';
import { fillLinkFacts, fragmentIndex, judgeLink, resolveLinkEntries, type FragmentIndex, type JudgeLinkOptions, type LinkEntry, type ValidateLinkOptions } from './link-validator.js';
import { ParseCache, type ParseCacheStats, parseKeyed, vatCacheRoot } from './parse-cache.js';
// Type-only, and that is what keeps it acyclic: the projection's population
// builder is a CALLER of the registry's world, not a dependency of it, so the
// import is erased before any module graph exists at runtime.
import type { ResourcePopulationSource } from './projection/resource-population.js';
import type { ResourceCollectionInterface } from './resource-collection-interface.js';
import type { SHA256 } from './schemas/checksum.js';
import type { ProjectConfig, ValidationMode } from './schemas/project-config.js';
import type { HeadingNode, ResourceMetadata } from './schemas/resource-metadata.js';
import type { ValidationResult } from './schemas/validation-result.js';
import { locationRoot, matchesGlobPattern, resolveLocalHref, sameDirectory } from './utils.js';

/**
 * Typed error thrown when two resources produce the same ID.
 *
 * Carries the authoritative id and both paths so callers can record accurate
 * issue data without re-deriving the id from the file path (which would be
 * wrong when the id came from a frontmatter `idField` value).
 */
/**
 * One first-added-wins drop: two files produced the same resource id, and the
 * later arrival was skipped.
 */
export interface DuplicateIdCollision {
  /** The id both files claimed. */
  id: string;
  /** Absolute path of the file that arrived first and therefore won. */
  existingPath: string;
  /** Absolute path of the file that arrived later and was skipped. */
  conflictingPath: string;
}

/**
 * Filesystem errno codes that mean "this path could not be read", as opposed to
 * "VAT is broken".
 *
 * Deliberately an allow-list rather than a catch-all. Demoting every non-
 * duplicate error to a finding would silently convert a parser or indexing
 * defect into a per-file warning, and the corpus-wide symptom of that is a
 * quietly shrinking population — the exact failure mode this code exists to
 * make loud.
 *
 * `ELOOP` is the symlink cycle; `ENOENT` the dangling symlink and the file
 * deleted between enumeration and parse; `EISDIR`/`ENOTDIR` a path whose type
 * changed underneath the crawl.
 */
const READ_FAILURE_CODES: ReadonlySet<string> = new Set([
  'EACCES',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENAMETOOLONG',
  'ENFILE',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
]);

/**
 * Whether an error is a filesystem read failure rather than a defect.
 *
 * @param error - The thrown value
 * @returns True when the error carries a recognized filesystem errno code
 */
function isReadFailure(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) {
    return false;
  }
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && READ_FAILURE_CODES.has(code);
}

/**
 * One enumerated file that could not be read, and so is absent from the
 * registry despite the crawl having found it.
 */
export interface UnreadableResource {
  /** Absolute path of the file that was enumerated but not admitted. */
  filePath: string;
  /** The underlying read failure, as reported by the filesystem. */
  reason: string;
  /** `ENOENT`, `EACCES`, … when the platform supplied one. */
  code?: string;
}

export class DuplicateResourceIdError extends Error {
  readonly id: string;
  readonly existingPath: string;
  readonly conflictingPath: string;

  constructor(id: string, conflictingPath: string, existingPath: string) {
    super(`Duplicate resource ID '${id}': '${conflictingPath}' conflicts with '${existingPath}'`);
    this.name = 'DuplicateResourceIdError';
    this.id = id;
    this.existingPath = existingPath;
    this.conflictingPath = conflictingPath;
  }
}

/**
 * The file kinds a resource crawl treats as resources when the caller supplies
 * no `include` patterns of its own.
 *
 * ONE home, deliberately exported: a caller that needs to NARROW the default
 * scan (the CLI scopes these to a subtree when `vat resources validate <path>`
 * is given a path argument) must derive its patterns from this list rather than
 * restate it — two copies would silently disagree the moment a new extension is
 * recognized here.
 */
export const DEFAULT_RESOURCE_INCLUDE: readonly string[] = ['**/*.md', '**/*.html', '**/*.htm'];

/**
 * The (bound, offered) root pairs already announced, so a run that crawls the
 * same mismatched pair per skill says it once instead of once per skill.
 *
 * Keyed on the PAIR and not on a single boolean: two different mismatches are two
 * different facts, and a process-wide "already warned" flag would hide the second
 * one behind the first.
 */
const announcedRootMismatches = new Set<string>();

/**
 * Say, on stderr, that a population source was declined for naming a different
 * root — and what the two roots were.
 *
 * The repo's standard, stated in `cli/src/utils/projection-store.ts`'s header: an
 * opted-in cache that quietly does nothing is worse than no cache. A silent
 * decline turns a wired lane into an invisible walk, so a measurement arm that
 * believes it is testing a projection tests an ordinary cold run — the failure
 * that has already cost this project one whole A/B.
 *
 * A warning rather than a throw or a `ValidationIssue`: the decline is not the
 * project's fault and produces the correct answer by a slower route, so it must
 * neither abort a build nor be reported at an adopter as a finding about their
 * corpus. Same posture, and the same channel, as `extract-plugin.ts` takes when
 * its own cache lane fails.
 *
 * @param boundRoot - The root the source declared it can answer for
 * @param offeredRoot - The resolved root this crawl asked it about
 */
function warnPopulationRootMismatch(boundRoot: string, offeredRoot: string): void {
  const resolvedBound = safePath.resolve(boundRoot);
  const pair = `${resolvedBound}\u0000${offeredRoot}`;
  if (announcedRootMismatches.has(pair)) return;
  announcedRootMismatches.add(pair);
  console.warn(
    '[vat] The resource population source is bound to '
    + `${resolvedBound} but this crawl asked it about ${offeredRoot}. `
    + 'Declining it and walking the tree instead, so this enumeration is on the '
    + 'incumbent crawler rather than the projection lane.',
  );
}

/**
 * Options for crawling directories to add resources.
 */
export interface CrawlOptions {
  /** Base directory to crawl */
  baseDir: string;
  /** Include patterns (default: {@link DEFAULT_RESOURCE_INCLUDE}) */
  include?: string[];
  /** Exclude patterns (default: node_modules, .git, dist) */
  exclude?: string[];
  /** Follow symbolic links (default: false) */
  followSymlinks?: boolean;
  /**
   * Where the file list comes from — omit for the incumbent `crawlDirectory`
   * walk, supply one to source it from a projection instead.
   *
   * The source answers ENUMERATION only. `include`/`exclude` are still applied
   * here, with {@link crawlPathFilter} — the same compiled matcher
   * `crawlDirectory` itself uses on its `git ls-files` branch — so the two lanes
   * cannot disagree about what the project's globs mean, only about which paths
   * were offered to them. That distinction is what makes an A/B between them
   * legible: a difference in the result is a difference in the population.
   *
   * Selecting the lane is the CLI's job, not this class's: an env read here
   * would put the switch below the boundary where the project root is resolved,
   * and a registry built by a library caller would silently change population
   * with the environment.
   *
   * A source that is bound to a different root than `baseDir` is DECLINED here
   * and this crawl walks instead — see {@link ResourceRegistry.populationFrom}
   * for the guard and why it declines rather than throwing.
   */
  populationSource?: ResourcePopulationSource;
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
  /**
   * Parse cache backing {@link ResourceRegistry.addResource} (optional).
   *
   * Omitted, a default {@link ParseCache} is created on first use — lazily, so
   * the `VAT_CACHE` read happens when a document is actually parsed rather than
   * when the registry is constructed. Supply one to point the cache at a
   * private directory, or to disable it (`new ParseCache({ enabled: false })`).
   */
  parseCache?: ParseCache;
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
  /** Strictly validate HTML fragment anchors against element ids (default: false; HTML fragments are often runtime-defined by JS). */
  checkHtmlAnchors?: boolean;
  /** Disable cache for external URL checks (default: false) */
  noCache?: boolean;
  /**
   * Deferred build-artifact model (a project's skills' `files:` config). Threaded
   * into every `local_file` link validation so a missing-but-declared target is
   * reported as info-severity `LINK_DEFERRED_ARTIFACT` instead of error-severity
   * `LINK_BROKEN_FILE` — see `deferred-artifacts.ts` and `link-validator.ts`.
   */
  deferredArtifacts?: DeferredArtifacts;
  /**
   * Validation framework config (severity overrides + per-code allow entries).
   * Applied INSIDE validate() via runSingleUnitValidation — the library, not the
   * CLI, resolves severity and drops ignored issues. Defaults to `{}` (no
   * overrides: every issue keeps its registry default severity).
   */
  validationConfig?: ValidationConfig;
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
 * True when the file HAS a frontmatter block that failed to parse.
 *
 * The distinction matters because a failed parse and an absent block both leave
 * `resource.frontmatter` undefined, and the schema validator sees only that.
 * Reading `undefined` as "absent" made VAT report `FRONTMATTER_MISSING` — "No
 * frontmatter found in file" — about files whose frontmatter is plainly present,
 * alongside the `FRONTMATTER_INVALID_YAML` that correctly described it: two
 * error-severity findings with contradictory remediations, one of them false.
 */
function hasUnparseableFrontmatter(resource: ResourceMetadata): boolean {
  return resource.frontmatterError !== undefined;
}

/**
 * The outcome of loading and compiling one collection schema, cached per
 * (resolved schema file, validation mode) for the lifetime of a registry.
 *
 * Failures are cached alongside successes deliberately: a schema that cannot be
 * read or compiled must still produce one FRONTMATTER_SCHEMA_ERROR per resource
 * in the collection, carrying the same message the first attempt produced.
 * Caching only successes would re-read and re-compile a broken schema once per
 * resource — the exact N+1 this cache exists to remove, on the slowest path.
 */
type LoadedCollectionSchema =
  | { readonly ok: true; readonly compiled: CompiledFrontmatterSchema }
  | { readonly ok: false; readonly error: unknown };

/**
 * Cache key for a compiled collection schema.
 *
 * Keyed on the RESOLVED schema path, not the configured specifier: two
 * collections may reference one schema file by different specifiers (a
 * relative path in one, an npm bare specifier in another) and must share the
 * compiled validator. The mode is part of the key because permissive mode
 * compiles a rewritten clone of the schema.
 *
 * The mode leads the key: it is a closed two-value enum, so no (path, mode)
 * pair can spell the same key as a different one however the path is written.
 */
function collectionSchemaCacheKey(resolvedSchemaPath: string, mode: ValidationMode): string {
  return `${mode}:${resolvedSchemaPath}`;
}

/**
 * Read a schema file and compile it for the given mode, capturing any failure
 * as a value so it can be cached and replayed per resource.
 */
async function readAndCompileSchema(
  resolvedSchemaPath: string,
  mode: ValidationMode,
  fsModule: typeof fs,
): Promise<LoadedCollectionSchema> {
  try {
    // Bytes from the injected fs, characters from the one decoder. Reading
    // `'utf-8'` here would hand `JSON.parse` a leading BOM — which throws — on
    // an adopter schema written by a Windows editor.
    const schemaBytes = await fsModule.readFile(resolvedSchemaPath);
    const schema = JSON.parse(decodeTextContent(schemaBytes).text) as object;
    return { ok: true, compiled: compileFrontmatterSchema(schema, mode) };
  } catch (error) {
    return { ok: false, error };
  }
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
  /** Base directory for resources. Used for relative-path ID generation and schema resolution. Set via constructor or propagated from crawl(). */
  baseDir?: string;

  /** Frontmatter field name to use as resource ID. */
  readonly idField?: string;

  /** Optional project configuration (enables collection support) */
  readonly config?: ProjectConfig;

  /** Optional git tracker for efficient git-ignore checking */
  readonly gitTracker?: GitTracker;

  /**
   * Filesystem lookup memo for the current `validate()` run.
   *
   * Replaced at the top of every run rather than kept for the registry's lifetime:
   * it caches directory *listings*, so a registry that outlives an edit (watch mode,
   * a server) must not answer the next run from the previous run's snapshot.
   */
  private fsCache: FsLookupCache = new FsLookupCache();

  /**
   * Disk-backed parse cache, created on first parse unless injected.
   *
   * Lazy rather than constructed in the constructor: `ParseCache` reads
   * `VAT_CACHE` once, per construction, so building it eagerly would bind the
   * decision to registry-construction time — an ordering a caller has no reason
   * to expect and a test cannot control without mutating the real `process.env`
   * before every `new ResourceRegistry()`.
   */
  private parseCacheInstance?: ParseCache;

  /**
   * Resources indexed by file path — **keyed in Unicode NFC (`toNfc`), not by
   * the raw path.**
   *
   * The two sides of this lookup come from different places and, on macOS,
   * routinely arrive in different Unicode normalization forms: a key is a
   * *enumerated* path (`readdir`/`git ls-files` hand back whatever is on disk,
   * commonly decomposed), while a query is a path *derived from markdown link
   * text* (`resolveLocalHref`, composed as an editor writes it). `Map.get` is
   * exact string equality, so `café.md` misses `café.md` and the link to a file
   * that plainly exists gets no `resolvedId` — see {@link resolveLinks} for what
   * a missing `resolvedId` then costs at packaging time. Ledger entry D7.
   *
   * ⚠️ Only the KEY is normalized. `resource.filePath` keeps the on-disk form,
   * because that is the string handed to the filesystem, and on Linux the
   * normalized form of a decomposed filename names no file at all
   * (see {@link toNfc}).
   *
   * The one behaviour this trades away: two files in one directory whose names
   * differ *only* by normalization form now collide on one key. APFS cannot
   * produce that pair (its lookup is normalization-insensitive); ext4 can, but
   * only pathologically, and shadowing one of them is a better answer than
   * reporting every link to either as broken.
   */
  private readonly resourcesByPath: Map<string, ResourceMetadata> = new Map();
  private readonly resourcesById: Map<string, ResourceMetadata> = new Map();
  private readonly resourcesByName: Map<string, ResourceMetadata[]> = new Map();
  private readonly resourcesByChecksum: Map<SHA256, ResourceMetadata[]> = new Map();

  /**
   * Frontmatter-sourced external URLs keyed by resource absolute path.
   * Populated during collection-schema validation; consumed by
   * collectExternalUrls so the URLs feed into the existing health-check pass.
   */
  private readonly frontmatterExternalUrlsByResource: Map<string, FrontmatterExternalUrl[]> = new Map();

  /**
   * Compiled collection schemas, keyed by {@link collectionSchemaCacheKey}.
   *
   * Ajv compilation dominates collection frontmatter validation and its result
   * depends on nothing but the schema and the mode, so compiling per resource
   * (the original shape of this code) recompiled the same handful of schemas
   * once per document — on a 129-document corpus with two distinct schemas,
   * ~400ms of pure repetition.
   *
   * Scoped to the registry instance rather than the module on purpose: a
   * long-lived process that re-crawls after a schema file is edited gets a new
   * registry and therefore a fresh read, never a stale validator. {@link clear}
   * drops it for the same reason.
   */
  private readonly compiledCollectionSchemas: Map<string, Promise<LoadedCollectionSchema>> = new Map();

  /**
   * Collisions recorded by addResources() when two files produce the same resource id.
   * Cleared by clear(). Surfaced as DUPLICATE_RESOURCE_ID issues in validate().
   */
  private duplicateIdCollisions: DuplicateIdCollision[] = [];

  /**
   * Files `addResources()` enumerated but could not read.
   * Cleared by clear(). Surfaced as RESOURCE_UNREADABLE issues in validate().
   */
  private unreadableResources: UnreadableResource[] = [];

  /**
   * Reads that failed, in the order `addResources` attempted them.
   *
   * Same rationale as {@link getDuplicateIdCollisions}: this is a population
   * fact. A file that was enumerated and then skipped is absent from every
   * downstream count, and an issue list says a read failed without letting a
   * caller reconcile "enumerated" against "admitted".
   *
   * @returns A copy of the failure log, oldest first
   */
  getUnreadableResources(): UnreadableResource[] {
    return [...this.unreadableResources];
  }

  /**
   * Duplicate-id drops, in the order `addResources` made them.
   *
   * Exposed because arrival order is behaviour, not bookkeeping: the rule is
   * first-added-wins, so which of two colliding files gets validated, bundled
   * and rewritten is decided by enumeration order. `validate()` turns these
   * into `DUPLICATE_RESOURCE_ID` issues; a caller that needs to compare
   * populations across a refactor needs the raw drops, because an issue list
   * says a collision happened without saying which file survived it.
   *
   * @returns A copy of the collision log, oldest first
   */
  getDuplicateIdCollisions(): DuplicateIdCollision[] {
    return [...this.duplicateIdCollisions];
  }

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
    if (options?.parseCache !== undefined) {
      this.parseCacheInstance = options.parseCache;
    }
  }

  /**
   * Parse-cache hit/miss counts for this registry.
   *
   * Read off the cache instance, so an INJECTED cache reports what it did for
   * every one of its users rather than for this registry alone. That is the
   * honest reading: the counters answer "did the cache serve anything", and a
   * caller that shares one instance across registries is asking about the
   * instance. A registry that has parsed nothing has no instance yet, and
   * reports zeroes rather than constructing one as a side effect of being asked.
   *
   * @returns A snapshot of the counters
   */
  getParseCacheStats(): ParseCacheStats {
    return this.parseCacheInstance?.stats ?? { hits: 0, misses: 0, writeFailures: 0 };
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
   * **Deliberately uncharged by the crawl-timing seam.** Unlike {@link crawl} and
   * {@link addResource}, this reads nothing and parses nothing — the caller
   * already paid for the resources it hands over, and its one shipped use is the
   * packager's registry over *output* it has just written. Charging it would put
   * post-build accounting on the incumbent crawler's total.
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

    // Indexing goes through `indexResource`, not a second copy of the four
    // index writes, so every index has exactly ONE key derivation. That matters
    // most for `resourcesByPath`, whose key is normalized (see the field's
    // docblock): a duplicated write here could silently key one construction
    // path differently from the other, and every lookup through the divergent
    // path would miss.
    for (const resource of resources) {
      const existingById = registry.resourcesById.get(resource.id);
      if (existingById) {
        throw new DuplicateResourceIdError(resource.id, resource.filePath, existingById.filePath);
      }

      registry.indexResource(resource);
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
   * Parses the file, generates a unique ID, and stores the resource. Costs
   * exactly one `readFile` and one `stat` per file — the parse, the checksum and
   * the size all come off that single pair. The parse itself may be served from
   * the disk-backed cache ({@link parseCached}); the read and the stat happen
   * either way, because the key and every non-parse field come from them.
   *
   * @param filePath - Path to the markdown file (will be normalized to absolute)
   * @returns The parsed resource metadata
   * @throws Error if file cannot be read or parsed
   *
   * ## Why this method is a wrapper
   *
   * It is one of the three points where **the incumbent crawler's preparation is
   * charged to `crawl-timing.ts`** — building this registry is what
   * `walkLinkGraph` consumes, and until that was bracketed the seam compared the
   * projection's whole crawl against the walker's traversal alone (see that
   * module's header). The bracket lives here, at the grain every construction
   * route funnels through, rather than at the six call sites that build a
   * registry: six copies would be six chances to disagree, and a seventh site
   * would silently escape the gate.
   *
   * The work moved into {@link admitResource} so the bracket could wrap it
   * whole without re-indenting it, and the `finally` charges a FAILED admission
   * too: a duplicate-id drop has already paid the read and the parse by the time
   * it is refused, and a seam that skipped it would report a corpus of collisions
   * as nearly free.
   *
   * @example
   * ```typescript
   * const resource = await registry.addResource('./docs/README.md');
   * console.log(`Added ${resource.id} with ${resource.links.length} links`);
   * ```
   */
  async addResource(filePath: string): Promise<ResourceMetadata> {
    const startedAt = crawlTimingStart();
    try {
      return await this.admitResource(filePath);
    } finally {
      recordRegistryPass(CRAWL_REGISTRY_ADD_RESOURCE_ID, startedAt);
    }
  }

  /**
   * Read, parse, key and index one file — {@link addResource} minus its timing
   * bracket.
   *
   * @param filePath - Path to the markdown file (will be normalized to absolute)
   * @returns The parsed resource metadata
   * @throws Error if file cannot be read or parsed
   * @private
   */
  private async admitResource(filePath: string): Promise<ResourceMetadata> {
    // Normalize path to absolute
    const absolutePath = safePath.resolve(filePath);

    // THE read. Everything below is a function of these bytes plus one stat —
    // this used to be two whole-file reads (parse, then checksum) and two stats.
    // The discriminator runs exactly ONCE here and its answer rides on `keyed`
    // into both the content key and the parser selection in `parseKeyed`:
    // parser selection is part of a document's parse identity (content-key.ts),
    // and running the discriminator twice is how the parse route and the key's
    // parse-route component drift apart.
    const keyed = await readContentWithKey(absolutePath, parserKindForPath(absolutePath));

    // Parse from the bytes already in hand — or from a cache entry filed under
    // the key those bytes just produced. See `parseKeyed` for the interception.
    this.parseCacheInstance ??= new ParseCache();
    const parseResult = await parseKeyed(keyed, this.parseCacheInstance);

    // Generate ID using priority chain: frontmatter field → relative path → filename stem
    const id = this.generateId(absolutePath, parseResult.frontmatter);

    // Check for duplicate ID (allow re-adding same file path). Deliberately
    // ahead of the stat below, so a file that loses an id collision costs no
    // syscall beyond the read it already paid for.
    const existingById = this.resourcesById.get(id);
    if (existingById && existingById.filePath !== absolutePath) {
      throw new DuplicateResourceIdError(id, absolutePath, existingById.filePath);
    }

    // THE stat — one call serving both `modifiedAt` and `sizeBytes`.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied path, same trust level as the read above
    const stats = await fs.stat(absolutePath);

    // Checksum from the bytes already decoded, not a second read of the file.
    // It hashes the DECODED STRING, which is a different keyspace from
    // `keyed.key` — that one hashes the raw bytes on purpose (content-key.ts).
    // Both must survive: this value is user-facing (`vat resources scan
    // --verbose`, `audit/cache-detector.ts`, `getResourcesByChecksum`).
    const checksum = calculateChecksumFromContent(keyed.content);

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
      ...(parseResult.anchors !== undefined && { anchors: parseResult.anchors }),
      ...(parseResult.parseErrors !== undefined && { parseErrors: parseResult.parseErrors }),
      ...(parseResult.unresolvedReferences !== undefined && {
        unresolvedReferences: parseResult.unresolvedReferences,
      }),
      ...(parseResult.frontmatter !== undefined && { frontmatter: parseResult.frontmatter }),
      ...(parseResult.frontmatterError !== undefined && { frontmatterError: parseResult.frontmatterError }),
      // `stat().size` — the on-disk byte count, exactly as before. Never
      // `Buffer.byteLength(content)` or `content.length`: those measure the
      // decoded string, and this number reaches packaged-output accounting
      // (agent-skills/src/content-transform.ts) and adopter-visible rule
      // variables.
      sizeBytes: stats.size,
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
      try {
        results.push(await this.addResource(fp));
      } catch (error) {
        if (error instanceof DuplicateResourceIdError) {
          this.duplicateIdCollisions.push({
            id: error.id,
            existingPath: error.existingPath,
            conflictingPath: error.conflictingPath,
          });
          // First-added wins; skip conflicting file and continue crawling.
        } else if (isReadFailure(error)) {
          // A file the crawl handed us that we cannot read. Recorded, not
          // thrown: previously this terminated `vat resources scan|validate`
          // and `vat audit` with a raw ENOENT stack trace, which a committed
          // dangling `*.md` symlink reaches on `crawlDirectory`'s git route
          // (that route returns mode-120000 entries and does no symlink
          // filtering).
          //
          // ⛔ Recorded rather than skipped, deliberately. Swallowing the read
          // would trade a loud crash for a silent population change — the file
          // would vanish from every downstream count with nothing said. It
          // becomes a RESOURCE_UNREADABLE issue in validate().
          this.unreadableResources.push({
            filePath: fp,
            reason: error.message,
            ...(typeof (error as { code?: unknown }).code === 'string' && {
              code: (error as { code: string }).code,
            }),
          });
        } else {
          // Not a read failure and not a collision: a genuine defect in parsing
          // or indexing, which must not be demoted to a finding.
          throw error;
        }
      }
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
      include = [...DEFAULT_RESOURCE_INCLUDE],
      exclude = ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      followSymlinks = false,
    } = options;

    // Propagate baseDir to registry if not already set (enables path-relative IDs)
    if (baseDir && !this.baseDir) {
      this.baseDir = baseDir;
    }

    // Use utils file crawler
    const crawlOptions: UtilsCrawlOptions = {
      baseDir,
      include,
      exclude,
      followSymlinks,
      absolute: true,
      filesOnly: true,
      // The validation universe is `tracked ∪ (untracked ∧ ¬ignored)` — what a
      // commit made right now WOULD contain. Without this, `crawlDirectory`'s
      // `git ls-files` fast path answers tracked-only, so a brand-new,
      // uncommitted, un-ignored markdown file is not merely missed, it is
      // invisible: the command exits green about the half it could see. That is
      // a defect, not a scoping choice — see
      // `docs/architecture/resource-scanning-and-caching.md` §2.1, which declares
      // the obligation, and the per-command scoring in
      // `docs/architecture/command-population-matrix.md`.
      //
      // `includeUntracked` rather than `respectGitignore: false`: it keeps the
      // fast path and it keeps ignored files out, which is the half of the
      // universe that must NOT widen (see {@link CrawlOptions.includeUntracked}).
      includeUntracked: true,
    };

    // The enumeration ALONE is charged here, not the whole method: `addResources`
    // below charges itself per file (see {@link addResource}), and a bracket
    // around both would produce a row that contains the other one. The two are
    // additive as written, which is what lets the incumbent arm be totalled.
    //
    // BOTH lanes are charged to this one id, deliberately. They answer the same
    // question and the point of the seam is to compare them, so a projection arm
    // that filed its cost under a different row would be incomparable with the
    // walker arm by construction. Which lane RAN is still readable, and from the
    // instrument rather than from the caller's intent: the projection reaches
    // `populate`, which files `builtin:filesystem` and `blob-population:derive`
    // in the `base` stratum — rows the walker arm cannot produce.
    //
    // ⚠️ Those `base` rows are NESTED INSIDE this one, not additive to it. On the
    // probe repository the projection arm read `enumerate` 27.0 ms against `base`
    // rows totalling 26.0 ms — so summing the two per-arm totals inflates the
    // projection arm and leaves the walker arm untouched, which corrupts the
    // RATIO and not merely the total. Compare `enumerate` to `enumerate`.
    // See `crawl-timing.ts` on stratum inheritance.
    //
    // `withOuterBracket` is what makes that warning true of the DUMP and not
    // only of this comment: the driver-placed rows inside now arrive at
    // `CRAWL_PASS_INSIDE`, where the existing classification already calls them
    // nested and the renderer already keeps them out of the total. It stayed a
    // comment for as long as it did because the seam's placement rule assumed
    // nothing could contain a driver-placed row, and this is the one call site
    // where something does.
    //
    // `populationFrom` may DECLINE — see its root guard — and a decline falls
    // back to the walk rather than to an empty list. `??` and not `||`: an empty
    // ARRAY is a legitimate population (a tree with no admitted members) and must
    // not re-trigger the walk, while `undefined` is the refusal.
    const { populationSource } = options;
    const enumerationStartedAt = crawlTimingStart();
    const sourced = populationSource
      ? await withOuterBracket(() => this.populationFrom(populationSource, baseDir, include, exclude))
      : undefined;
    const files = sourced ?? await crawlDirectory(crawlOptions);
    recordRegistryPass(CRAWL_REGISTRY_ENUMERATE_ID, enumerationStartedAt);

    // Add all found files
    return await this.addResources(files);
  }

  /**
   * Narrow a projection-supplied population to what this crawl's globs admit —
   * **or decline the source outright, when it is not bound to this root.**
   *
   * The source enumerates a ROOT; `include`/`exclude` are declared relative to
   * the crawl's `baseDir`. Re-basing here rather than assuming they coincide
   * keeps the coordinate system explicit: a path outside `baseDir` relativizes to
   * a `../`-prefixed spelling, which no root-relative glob matches, so it is
   * declined rather than silently admitted under a nonsense name.
   *
   * ## The root guard, and why this is the only place it belongs
   *
   * This is the single place in the toolkit where a {@link ResourcePopulationSource}
   * meets a root, so a check here makes every present and future forwarding site
   * safe by construction. A source bound to tree A, asked about tree B, would
   * build B's population with A's ignore oracle and — with a projection store
   * open — file it under **A's extent key**; the next run would read that back
   * and believe it. That is worse than a wrong answer in one run, and it is not
   * expressible as an error unless the source carries its own root, which is why
   * it does.
   *
   * ⛔ **A mismatch declines to the WALK, never to an empty population.** An
   * empty file list means "no files", so a validation lane would report a
   * confident green over a corpus it never looked at — silently deleting
   * findings, which is the exact outcome the guard exists to prevent.
   *
   * ⛔ **And it declines rather than throwing.** A mismatch is not always a
   * programming error: `packaging-validator.ts`'s
   * `findProjectRoot(...) ?? dirname(skillPath)` legitimately resolves to a build
   * output directory in an adopter layout with no config and no `.git` above it,
   * and throwing there would break real builds over a lane the adopter opted into
   * for speed.
   *
   * The decline is announced, once per (bound, offered) pair — see
   * {@link warnPopulationRootMismatch}.
   *
   * @param source - The enumeration lane, carrying the one root it can answer for
   * @param baseDir - The basis the caller's globs are written against
   * @param include - Include globs
   * @param exclude - Exclude globs
   * @returns Absolute paths of the admitted files, or `undefined` when the source
   *   is bound to a different root and the caller should walk instead
   */
  private async populationFrom(
    source: ResourcePopulationSource,
    baseDir: string,
    include: string[],
    exclude: string[],
  ): Promise<string[] | undefined> {
    const base = safePath.resolve(baseDir);
    if (!sameDirectory(source.root, base)) {
      warnPopulationRootMismatch(source.root, base);
      return undefined;
    }
    const isMember = crawlPathFilter(include, exclude);
    const admitted: string[] = [];
    for (const absolutePath of await source.enumerate(base)) {
      if (isMember(safePath.relative(base, absolutePath))) {
        admitted.push(absolutePath);
      }
    }
    return admitted;
  }

  /**
   * Check for YAML parsing errors in all resources.
   * @private
   */
  private collectYamlErrors(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const resource of this.resourcesByPath.values()) {
      if (resource.frontmatterError) {
        issues.push(
          createRegistryIssue(
            'FRONTMATTER_INVALID_YAML',
            `Invalid YAML syntax in frontmatter: ${resource.frontmatterError}`,
            { location: issueLocation(resource.filePath, locationRoot(this.baseDir)), line: 1 },
          ),
        );
      }
    }
    return issues;
  }

  /**
   * Emit MALFORMED_HTML issues from each resource's HTML parse errors.
   * @private
   */
  private collectHtmlParseErrors(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const resource of this.resourcesByPath.values()) {
      for (const parseError of resource.parseErrors ?? []) {
        issues.push(
          createRegistryIssue(
            'MALFORMED_HTML',
            `Malformed HTML: ${parseError.message}`,
            {
              location: issueLocation(resource.filePath, locationRoot(this.baseDir)),
              ...(parseError.line !== undefined && { line: parseError.line }),
            },
          ),
        );
      }
    }
    return issues;
  }

  /**
   * Emit `LINK_UNRESOLVED_REFERENCE` warnings for dangling reference-style
   * links (full `[text][label]` / collapsed `[label][]` forms with no
   * matching `[label]: url` definition) found by the raw-source scan in
   * `link-parser.ts`'s `findUnresolvedReferences`. These never become
   * `linkReference` AST nodes, so they cannot flow through `validateAllLinks`
   * like every other link code — they are collected here instead, the same
   * way `collectHtmlParseErrors` surfaces another parser-produced diagnostic
   * that isn't itself a `ResourceLink`.
   * @private
   */
  private collectUnresolvedReferenceIssues(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const resource of this.resourcesByPath.values()) {
      for (const unresolved of resource.unresolvedReferences ?? []) {
        issues.push(
          createRegistryIssue(
            'LINK_UNRESOLVED_REFERENCE',
            `Reference-style link "[${unresolved.label}]" has no matching definition. ` +
              `Add "[${unresolved.label}]: <url>" or rewrite as an inline link.`,
            {
              location: issueLocation(resource.filePath, locationRoot(this.baseDir)),
              line: unresolved.line,
            },
          ),
        );
      }
    }
    return issues;
  }

  /**
   * Emit DUPLICATE_RESOURCE_ID errors for collisions recorded by addResources().
   * @private
   */
  private collectDuplicateIdErrors(): ValidationIssue[] {
    return this.duplicateIdCollisions.map(({ id, existingPath, conflictingPath }) =>
      createRegistryIssue(
        'DUPLICATE_RESOURCE_ID',
        `Two files resolve to the same resource id '${id}': '${issueLocation(existingPath, locationRoot(this.baseDir))}' and '${issueLocation(conflictingPath, locationRoot(this.baseDir))}'. Rename one of the files so they produce distinct resource ids.`,
      ),
    );
  }

  /**
   * Emit RESOURCE_UNREADABLE errors for reads that failed during addResources().
   *
   * The message states that the file was **skipped**, because the consequence
   * a reader needs is not "a read failed" but "this file is in none of the
   * counts you are about to read".
   * @private
   */
  private collectUnreadableResourceErrors(): ValidationIssue[] {
    return this.unreadableResources.map(({ filePath, code }) => {
      const where = issueLocation(filePath, locationRoot(this.baseDir));
      const errno = code === undefined ? '' : ` (${code})`;
      return createRegistryIssue(
        'RESOURCE_UNREADABLE',
        // `reason` (the raw fs error message) is deliberately omitted: Node's fs
        // errors embed the absolute path (e.g. "ENOENT: ... open '/Users/...'"),
        // which would leak the developer's home directory into CI logs -- the
        // same class of leak `where` was computed to avoid. The errno code is
        // signal enough; see the ValidationIssue docstring's `location` contract.
        `'${where}' was enumerated but could not be read, so it was skipped and is absent from every count in this report${errno}.`,
        { location: where },
      );
    });
  }

  /**
   * Validate all links in all resources, in two passes.
   *
   * Pass 1 resolves every link once, then materialises both judge columns over
   * the corpus at once (`fillLinkFacts`): one listing per distinct target
   * directory, and one canonical path per distinct target plus the project
   * root. Pass 2 judges every link synchronously against those tables. The
   * alternative — awaiting each link in turn — serialised every cold `readdir`
   * and every `realpath` behind the previous link's `await`.
   *
   * ⚠️ **The judge loop is fully synchronous: it contains no `await`, so it
   * never yields to the event loop.** On a large corpus it is one
   * un-interruptible block, and it is not free — whenever `this.gitTracker` is
   * undefined and `skipGitIgnoreCheck` is false, every *existing* local target
   * still reaches `gitIgnoreSafetyIssue` → `isGitIgnored`, a `spawnSync` of
   * `git check-ignore`. That is the one column pass 1 does not materialise
   * (ledger entry D9); the listing and realpath columns both are.
   *
   * Both passes walk `entries` in the same order the single-pass version
   * produced issues in (resources in insertion order, links in document order);
   * issue order is part of this command's output contract.
   *
   * @private
   */
  private async validateAllLinks(
    fragmentsByFile: FragmentIndex,
    skipGitIgnoreCheck: boolean,
    checkHtmlAnchors: boolean,
    deferredArtifacts: DeferredArtifacts | undefined,
  ): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    const entries: LinkEntry[] = [];
    for (const resource of this.resourcesByPath.values()) {
      for (const link of resource.links) {
        entries.push({ link, sourceFilePath: resource.filePath });
      }
    }

    // Pass 1′: resolve each link exactly once, then fill both judge columns
    // together over exactly those resolutions. The judge reads these very
    // resolution objects — it never re-resolves.
    const resolved = resolveLinkEntries(entries, this.baseDir);
    const tables = await fillLinkFacts(resolved, this.fsCache, {
      ...(this.baseDir !== undefined && { projectRoot: this.baseDir }),
      skipGitIgnoreCheck,
    });

    // Only pass options if projectRoot is defined (exactOptionalPropertyTypes requirement)
    const judgeOptions: JudgeLinkOptions = this.baseDir === undefined
      ? { ...tables, skipGitIgnoreCheck, checkHtmlAnchors }
      : {
          ...tables,
          projectRoot: this.baseDir,
          skipGitIgnoreCheck,
          checkHtmlAnchors,
          ...(this.gitTracker !== undefined && { gitTracker: this.gitTracker }),
          ...(deferredArtifacts !== undefined && { deferredArtifacts }),
        };

    for (const entry of resolved) {
      const issue = judgeLink(entry, fragmentsByFile, judgeOptions);
      if (issue) {
        issues.push(issue);
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
    // One compile for the whole corpus — the schema and mode are the same for
    // every resource, so compiling inside the loop was pure repetition.
    const compiled = compileFrontmatterSchema(schema, mode);
    for (const resource of this.resourcesByPath.values()) {
      if (hasUnparseableFrontmatter(resource)) {
        continue;
      }
      const frontmatterIssues = validateCompiledFrontmatter(
        resource.frontmatter,
        compiled,
        resource.filePath,
        undefined,
        this.baseDir,
      );
      issues.push(...frontmatterIssues);
    }
    return issues;
  }

  /**
   * Validate frontmatter against per-collection schemas.
   * @private
   */
  private async validateCollectionFrontmatter(
    fragmentsByFile: FragmentIndex,
    skipGitIgnoreCheck: boolean,
  ): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    // Skip if no config
    if (!this.config?.resources?.collections) {
      return issues;
    }

    for (const resource of this.resourcesByPath.values()) {
      // Skip if resource has no collections
      if (!resource.collections || resource.collections.length === 0) {
        continue;
      }

      // Validate against each collection's schema
      const collectionIssues = await this.validateResourceCollectionSchemas(
        resource,
        fs,
        fragmentsByFile,
        skipGitIgnoreCheck,
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
    fsModule: typeof fs,
    fragmentsByFile: FragmentIndex,
    skipGitIgnoreCheck: boolean,
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
        fsModule,
        fragmentsByFile,
        skipGitIgnoreCheck,
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
    validation: NonNullable<NonNullable<ProjectConfig['resources']>['collections']>[string]['validation'],
    fsModule: typeof fs,
    fragmentsByFile: FragmentIndex,
    skipGitIgnoreCheck: boolean,
  ): Promise<ValidationIssue[]> {
    if (!validation?.frontmatterSchema) {
      return [];
    }

    // A document whose frontmatter did not parse is not a document with no
    // frontmatter. `collectYamlErrors` already reported the parse failure, which
    // is the actionable finding; saying anything further about fields we could
    // not read would contradict it.
    if (hasUnparseableFrontmatter(resource)) {
      return [];
    }

    const schemaPath = resolveAssetReference(
      validation.frontmatterSchema,
      this.baseDir ?? process.cwd(),
    );

    // Determine validation mode (default to permissive)
    const mode = validation.mode ?? 'permissive';

    // This `try` covers the schema load/compile and NOTHING else. Its `catch`
    // blames the schema by name, so everything it can catch must genuinely be a
    // failure to read, parse or compile that schema file.
    //
    // `validateCompiledFrontmatter` sits OUTSIDE it, argued from that message:
    // running an already-compiled validator over a document is neither loading
    // nor parsing a schema, and by that point the schema is proven good —
    // `readAndCompileSchema` has read the file, `JSON.parse`d it and put it
    // through `ajv.compile()`. A throw from the compiled validator is an Ajv
    // runtime fault, and "Failed to load or parse frontmatter schema" would be a
    // false statement about it. The same reasoning applies more sharply to
    // `validateFrontmatterLinks` below: it is link validation, not schema
    // handling, and the fact tables it reads throw ON PURPOSE
    // (`realpathFrom`/`siblingNamesFrom` crash on a missing row so that a
    // fill/judge divergence names its own remedy). That crash must reach the
    // operator intact rather than be reworded into a schema complaint — do not
    // re-wrap either call.
    //
    // ⚠️ **The widening is intended for ALL throws out of those two calls, not
    // just the fill/judge one.** An Ajv runtime fault, an fs error inside link
    // validation, anything else — each now escapes `registry.validate()` and
    // aborts the run, where before it became one `FRONTMATTER_SCHEMA_ERROR` per
    // resource in the collection. That is a real change in operator-visible
    // behaviour and it is deliberate: none of those are a defect in the user's
    // schema, and reporting them as one sends the reader to edit a file that is
    // fine. A crash that names the real fault beats N findings that name the
    // wrong one. Anything here that SHOULD become a finding must be caught at
    // its own call site with its own code — never by widening this `try` back.
    let compiled: CompiledFrontmatterSchema;
    try {
      const loaded = await this.loadCollectionSchema(schemaPath, mode, fsModule);
      if (!loaded.ok) {
        // Rethrow the cached load/compile failure so every resource in the
        // collection reports it identically, without re-reading the file.
        throw loaded.error;
      }
      compiled = loaded.compiled;
    } catch (error) {
      // Handle missing or invalid schema files gracefully
      const errorMessage = error instanceof Error ? error.message : String(error);
      return [
        createRegistryIssue(
          'FRONTMATTER_SCHEMA_ERROR',
          `Failed to load or parse frontmatter schema '${validation.frontmatterSchema}': ${errorMessage}`,
          { location: issueLocation(resource.filePath, locationRoot(this.baseDir)), line: 1 },
        ),
      ];
    }

    // Validate frontmatter against JSON Schema
    const issues = validateCompiledFrontmatter(
      resource.frontmatter,
      compiled,
      resource.filePath,
      schemaPath,
      this.baseDir,
    );

    // Walk URI-family frontmatter values. Default-on; explicit `false` disables.
    if (validation.checkFrontmatterLinks !== false && resource.frontmatter) {
      const linkOptions: ValidateLinkOptions = this.baseDir === undefined
        ? { fsCache: this.fsCache, skipGitIgnoreCheck }
        : {
            fsCache: this.fsCache,
            projectRoot: this.baseDir,
            skipGitIgnoreCheck,
            ...(this.gitTracker !== undefined && { gitTracker: this.gitTracker }),
          };

      const { issues: linkIssues, externalUrls } = await validateFrontmatterLinks(
        resource.frontmatter,
        compiled.schema,
        resource.filePath,
        fragmentsByFile,
        linkOptions,
      );
      issues.push(...linkIssues);

      if (externalUrls.length > 0) {
        const prior = this.frontmatterExternalUrlsByResource.get(resource.filePath) ?? [];
        this.frontmatterExternalUrlsByResource.set(resource.filePath, [...prior, ...externalUrls]);
      }
    }

    return issues;
  }

  /**
   * Read, parse and compile a collection schema — at most once per
   * (resolved path, mode) for this registry.
   *
   * The in-flight promise is what gets cached, so concurrent callers share one
   * read and one compile rather than racing to populate the entry.
   *
   * @private
   */
  private async loadCollectionSchema(
    schemaPath: string,
    mode: ValidationMode,
    fsModule: typeof fs,
  ): Promise<LoadedCollectionSchema> {
    const key = collectionSchemaCacheKey(schemaPath, mode);
    const cached = this.compiledCollectionSchemas.get(key);
    if (cached) {
      return cached;
    }

    const pending = readAndCompileSchema(schemaPath, mode, fsModule);
    this.compiledCollectionSchemas.set(key, pending);
    return pending;
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

    // Fresh per run: directory listings are a snapshot, and a registry can outlive
    // the state it was validated against.
    this.fsCache = new FsLookupCache();

    // Build fragment index for anchor validation
    const fragmentsByFile = this.buildFragmentIndex();

    // Reset frontmatter external URL state for this validation run
    this.frontmatterExternalUrlsByResource.clear();

    // Collect all validation issues
    const issues: ValidationIssue[] = [];

    // Surface parse-time diagnostics: YAML frontmatter errors first, then HTML
    // well-formedness, then dangling reference-style links, then duplicate-id
    // collisions. Combined into one push() call (SonarCloud S7778).
    issues.push(
      ...this.collectYamlErrors(),
      ...this.collectHtmlParseErrors(),
      ...this.collectUnresolvedReferenceIssues(),
      ...this.collectDuplicateIdErrors(),
      ...this.collectUnreadableResourceErrors(),
    );

    // Validate each link in each resource
    const linkIssues = await this.validateAllLinks(
      fragmentsByFile,
      options?.skipGitIgnoreCheck ?? false,
      options?.checkHtmlAnchors ?? false,
      options?.deferredArtifacts,
    );
    issues.push(...linkIssues);

    // Per-collection frontmatter validation
    const collectionFrontmatterIssues = await this.validateCollectionFrontmatter(
      fragmentsByFile,
      options?.skipGitIgnoreCheck ?? false,
    );
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

    // Resolve severity + apply allow-filter INSIDE the library (not the CLI).
    // `emitted` = post-allow-filter, severity-resolved, with `ignore`d dropped.
    //
    // Single-unit: one `validate()` covers the WHOLE registry, so this call is
    // the entire run and "no issue matched this allow entry" is answerable here.
    // (Unlike the per-skill lanes, which need a run-level ledger.)
    const framework = runSingleUnitValidation(issues, options?.validationConfig ?? {});
    const emitted = framework.emitted;
    const errorCount = emitted.length;

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
      issues: emitted,
      errorCount,
      passed: errorCount === 0,
      hasErrors: framework.hasErrors,
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

    // Expand any `resources.linkAuth` providers from macro refs into the engine
    // shape (#113 §5). When the adopter has no linkAuth config, the validator
    // skips the authenticated branch and uses the existing markdown-link-check
    // path for every URL — identical to pre-#113 behavior.
    const adopterLinkAuth = this.config?.resources?.linkAuth;
    const linkAuthConfig = adopterLinkAuth
      ? buildLinkAuthEngineConfig(adopterLinkAuth)
      : undefined;

    // Create validator. Imported here rather than at module scope: this module
    // is on every scan's critical path, while external-link-validator pulls
    // `markdown-link-check` (~409ms of load on Windows) that only URL
    // validation ever needs.
    const { ExternalLinkValidator } = await import('./external-link-validator.js');
    const validator = new ExternalLinkValidator(cacheDir, {
      timeout: 15000,
      cacheTtlHours: noCache ? 0 : 24,
      ...(linkAuthConfig !== undefined && { linkAuthConfig }),
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
    // `vatCacheRoot()` rather than a second `normalizedTmpdir()` + literal join:
    // one authority for where the shared cache tree lives (see parse-cache.ts).
    return vatCacheRoot();
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

    // Merge frontmatter-sourced external URLs from collection validation
    for (const [resourcePath, urls] of this.frontmatterExternalUrlsByResource) {
      for (const fmUrl of urls) {
        const locations = urlsToValidate.get(fmUrl.url) ?? [];
        locations.push({ resourcePath });
        urlsToValidate.set(fmUrl.url, locations);
      }
    }

    return urlsToValidate;
  }

  /**
   * Convert validation results to validation issues.
   * @private
   */
  private convertValidationResultsToIssues(
    results: Array<{ url: string; status: 'ok' | 'error'; statusCode: number; error?: string; code?: IssueCode }>,
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

      // Prefer a code surfaced by the validator's authenticated branch (#113 §7) —
      // those LINK_AUTH_* codes encode per-provider notFoundMeaning routing that
      // statusCode alone cannot express. Fall back to the statusCode mapping for
      // the anonymous markdown-link-check path.
      const issueCode = result.code ?? this.determineExternalUrlIssueCode(result.statusCode, result.error);
      const errorMessage = result.error ?? `HTTP ${result.statusCode}`;

      for (const location of locations) {
        issues.push(
          createRegistryIssue(issueCode, `External URL failed: ${errorMessage}`, {
            location: issueLocation(location.resourcePath, locationRoot(this.baseDir)),
            link: result.url,
            ...(location.line !== undefined && { line: location.line }),
          }),
        );
      }
    }

    return issues;
  }

  /**
   * Determine the registry issue code based on the external-URL validation error.
   * @private
   */
  private determineExternalUrlIssueCode(statusCode: number, error?: string): IssueCode {
    if (statusCode === 0) {
      const errorLower = error?.toString().toLowerCase();
      if (errorLower?.includes('timeout')) {
        return 'EXTERNAL_URL_TIMEOUT';
      }
      return 'EXTERNAL_URL_ERROR';
    }
    return 'EXTERNAL_URL_DEAD';
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
    // The third of the incumbent's charged phases, and the last one before
    // `walkLinkGraph` runs: the walk follows `resolvedId`, so this is the edge
    // list being built. Bracketed linearly rather than in a `finally` — unlike an
    // admission, a throw out of here is a defect that ends the run, so there is no
    // "it failed but it cost something" case to account for.
    const startedAt = crawlTimingStart();
    for (const resource of this.resourcesByPath.values()) {
      for (const link of resource.links) {
        if (link.type === 'local_file') {
          // Resolve the target file path
          const targetPath = this.resolveRelativeLinkPath(link.href, resource.filePath);
          if (targetPath === undefined) continue;

          // Look up resource by path. `targetPath` comes from markdown link
          // text and the keys come from filesystem enumeration, so the two can
          // differ in Unicode normalization form for the very same file — hence
          // the NFC key on both sides (see the field's docblock).
          const targetResource = this.resourcesByPath.get(toNfc(targetPath));

          if (targetResource) {
            link.resolvedId = targetResource.id;
          }
        }
      }
    }
    recordRegistryPass(CRAWL_REGISTRY_RESOLVE_LINKS_ID, startedAt);
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
    const absolutePath = safePath.resolve(filePath);
    return this.resourcesByPath.get(toNfc(absolutePath));
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
    this.duplicateIdCollisions = [];
    this.unreadableResources = [];
    // Compiled schemas are snapshots of files on disk: a registry being reused
    // for a fresh crawl must re-read them rather than trust a prior compile.
    this.compiledCollectionSchemas.clear();
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
   * Build a format-neutral fragment index for anchor validation: each file's
   * absolute path → the set of valid fragment targets. Markdown contributes
   * heading slugs (lowercased); HTML contributes its `id`/`name` anchors.
   */
  private buildFragmentIndex(): FragmentIndex {
    // Built through `fragmentIndex()` rather than `map.set` so that the index's
    // key derivation — NFC-normalized, see that function — has exactly one home
    // and cannot drift from what `checkAnchor` looks up. The per-entry policy
    // (case-sensitive ids vs folded slugs) is derived from the file type there.
    const entries: [string, Set<string>][] = [];
    for (const resource of this.resourcesByPath.values()) {
      const fragments = new Set<string>();
      collectHeadingSlugs(resource.headings, fragments);
      for (const anchor of resource.anchors ?? []) {
        fragments.add(anchor);
      }
      entries.push([resource.filePath, fragments]);
    }
    return fragmentIndex(entries);
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
    // Index by path (1:1) — NFC key, see the field's docblock
    this.resourcesByPath.set(toNfc(resource.filePath), resource);

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
   * Resolve a link href to an absolute file path.
   *
   * Delegates to the canonical {@link resolveLocalHref} so this registry agrees
   * with every other lane on what an href means — in particular that a leading
   * `/` is an RFC 3986 §4.2 project-root-relative reference (resolved against
   * `baseDir`), NOT a filesystem-absolute path, and that `%20`-style escapes are
   * decoded before resolution.
   *
   * A private path-only resolver used to live here, and the divergence was not
   * theoretical: the skill packager's link-graph walker resolves root-relative
   * hrefs correctly (so it bundles the target), while this resolver sent them to
   * the OS root and found nothing. The link then got no `resolvedId`, the
   * bundled-link template rendered an empty path and STRIPPED the href, and the
   * bundled file shipped with nothing pointing at it — surfacing as an
   * error-severity `PACKAGED_UNREFERENCED_FILE` that failed the build, plus
   * silently de-linked prose in every packaged doc that used the root-relative
   * form.
   *
   * @param linkHref - The href from the link (e.g., './file.md', '/docs/file.md#anchor')
   * @param sourceFilePath - Absolute path to the source file
   * @returns Absolute path to the target file, or undefined when the href is
   *   anchor-only or is a root-relative reference that cannot be resolved
   *   (no `baseDir`, or it escapes the project).
   */
  private resolveRelativeLinkPath(linkHref: string, sourceFilePath: string): string | undefined {
    const resolution = resolveLocalHref(linkHref, sourceFilePath, this.baseDir);
    return resolution.kind === 'resolved' ? resolution.resolvedPath : undefined;
  }
}

/** Recursively collect lowercased heading slugs into `out`. */
function collectHeadingSlugs(headings: HeadingNode[], out: Set<string>): void {
  for (const heading of headings) {
    out.add(heading.slug.toLowerCase());
    if (heading.children) {
      collectHeadingSlugs(heading.children, out);
    }
  }
}

/**
 * Generate an ID from a file path.
 *
 * Every resource id includes a `-<ext>` suffix derived from the file extension
 * (dot stripped, lowercased). This makes ids from different file types distinct
 * even when the stem is identical (e.g. `foo.md` → `foo-md`, `foo.html` → `foo-html`).
 * Extensionless files (e.g. `Makefile`) receive no suffix.
 *
 * When `baseDir` is provided, computes a relative path from baseDir and uses the full
 * directory structure in the ID. When no `baseDir`, uses the filename stem only.
 *
 * @param filePath - Absolute file path
 * @param baseDir - Base directory for relative path computation (optional)
 * @returns Generated ID in kebab-case with `-<ext>` suffix
 *
 * @example
 * ```typescript
 * // Without baseDir: filename stem + extension suffix
 * generateIdFromPath('/project/docs/User Guide.md')  // 'user-guide-md'
 * generateIdFromPath('/project/README.md')            // 'readme-md'
 * generateIdFromPath('/project/page.html')            // 'page-html'
 * generateIdFromPath('/project/Makefile')             // 'makefile'
 *
 * // With baseDir: relative path + extension suffix
 * generateIdFromPath('/project/docs/concepts/core/overview.md', '/project/docs')  // 'concepts-core-overview-md'
 * generateIdFromPath('/project/docs/guide.md', '/project/docs')                   // 'guide-md'
 * ```
 */
export function generateIdFromPath(filePath: string, baseDir?: string): string {
  let rawId: string;
  let extSuffix = '';

  if (baseDir) {
    // Compute relative path from baseDir, remove extension
    const relativePath = safePath.relative(baseDir, filePath);
    const ext = path.extname(relativePath);
    const withoutExt = ext ? relativePath.slice(0, -ext.length) : relativePath;
    // Normalize path separators to forward slashes (cross-platform), then replace with hyphens
    rawId = toForwardSlash(withoutExt).replaceAll('/', '-');
    if (ext) {
      // Strip the leading dot; lowercasing happens in the kebab pipeline below
      extSuffix = `-${ext.slice(1)}`;
    }
  } else {
    // Fallback: basename only (no directory context)
    const ext = path.extname(filePath);
    rawId = path.basename(filePath, ext);
    if (ext) {
      extSuffix = `-${ext.slice(1)}`;
    }
  }

  // Append extension suffix before the kebab pipeline so hyphen-collapse and
  // trim apply uniformly (e.g. suffixed-.md → 'suffixed--md' → 'suffixed-md')
  rawId = `${rawId}${extSuffix}`;

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


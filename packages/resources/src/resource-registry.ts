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

import { CODE_REGISTRY, createRegistryIssue, type IssueCode, runSingleUnitValidation, type ValidationConfig, type ValidationIssue, type ValidationIssueCode } from '@vibe-agent-toolkit/schema';
import {
  ASSET_REFERENCE_UNREADABLE_CODE,
  ASSET_REFERENCE_UNRESOLVED_CODE,
  CRAWL_REGISTRY_ADMIT_ID,
  CRAWL_REGISTRY_ENUMERATE_ID,
  classifyFsFault,
  compareCodeUnits,
  CRAWL_REGISTRY_RESOLVE_LINKS_ID,
  countWork,
  crawlTimingStart,
  forEachInOrder,
  FsLookupCache,
  issueLocation,
  isVatError,
  recordRegistryPass,
  requireFollowedStat,
  resolveAssetReference,
  safePath,
  toForwardSlash,
  toNfc,
  VatError,
  withOuterBracket,
  appendAll,
} from '@vibe-agent-toolkit/utils';
import {
  BUILD_OUTPUT_GLOBS,
  crawlPathFilter,
  NEVER_CONTENT_GLOBS,
} from '@vibe-agent-toolkit/utils/crawl';
import { type GitTracker } from '@vibe-agent-toolkit/utils/git';
import { decodeTextContent } from '@vibe-agent-toolkit/utils/text';

import { vatLinkCacheDirectory } from './cache-root.js';
import { compileCollectionMembership } from './collection-matcher.js';
import { type ContentKey, type KeyedContent, type ParserKind, readContentWithKey } from './content-key.js';
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
import { fillLinkFacts, fragmentIndex, judgeLink, resolveLinkEntries, unreadableTargetsFrom, type FragmentIndex, type JudgeLinkOptions, type LinkEntry, type ValidateLinkOptions } from './link-validator.js';
import { type NotAdmittedLog, notAdmittedIssues, parseRefusal } from './not-admitted.js';
import { ParseCache, type ParseCacheStats } from './parse-cache.js';
import { ParseDispatcher, type ParsePoolPolicy, driveInOrder, tallyParsable } from './parse-dispatcher.js';
import { isReadFailure, readFailureCode } from './parse-failure.js';
import { isParserThrewError, isPerRunParseRefusal, ParseLimitError, reviveParserThrow } from './parse-limits.js';
import type { NotAdmittedEntry } from './projection/blob-refusals.js';
import { blobResourceFactsOf, optionalParseFacts } from './projection/blob-resource-facts.js';
import { POPULATION_PARSE_LIMITS } from './projection/content-cache.js';
import { isDeclinedSymlinkCode } from './projection/contributors/filesystem-extent.js';
import { declinedLinkApplies, type PopulationUnreadablePolicy } from './projection/crawl-source.js';
import { contentRoute } from './projection/document-facts.js';
import { parseFailedEntry, parseFailedMessage } from './projection/parse-failure.js';
import { collectionMimeConflictFinding } from './projection/realizations.js';
// Type-only, and that is what keeps it acyclic: the projection's population
// builder is a CALLER of the registry's world, not a dependency of it, so the
// import is erased before any module graph exists at runtime.
import type {
  CrawlPopulation,
  IgnoredRefusals,
  PopulationMembers,
  ResourceEnumeration,
  ResourcePopulationSource,
} from './projection/resource-population.js';
import { type CollectionMimeResolver, parseRoutingFor, parserKindForResolvedPath } from './projection/router.js';
import type { AdmittedFacts, AdmittedStat, RunPopulation } from './projection/run-population.js';
import type { ResourceCollectionInterface } from './resource-collection-interface.js';
import type { ProjectConfig, ValidationMode } from './schemas/project-config.js';
import type { RealizationConditionRow } from './schemas/projection-resources.js';
import type { HeadingNode, ResourceLink, ResourceMetadata } from './schemas/resource-metadata.js';
import type { ValidationResult } from './schemas/validation-result.js';
import { locationRoot, matchesGlobPattern, resolveLocalHref } from './utils.js';

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

/**
 * Everything a preparation can conclude about one file, **as a VALUE**.
 *
 * The whole point of the type: preparation runs concurrently, so anything it
 * decided has to be carried back to the sequential half rather than acted on
 * where it was decided. A preparation that recorded its own finding would put
 * `unreadableResources` in completion order while the returned resources stayed
 * in input order — two outputs of one call disagreeing about what "first" means.
 *
 * ⛔ `failed` exists for the same reason and is the subtler half. It is a value
 * rather than a throw because only this lane can say which failures are findings
 * and which are defects: a read failure is a finding to be recorded and carried
 * on from, and nothing outside `prepareAdmission` can tell the two apart. The
 * run still fails on a genuine defect — from
 * {@link ResourceRegistry.emitPreparedResource}, on the first offender in input
 * order.
 */
type PreparedResource =
  | { outcome: 'admitted'; resource: ResourceMetadata }
  | { outcome: 'unreadable'; filePath: string; reason: string; code?: string; error: Error }
  | { outcome: 'parse-refused'; filePath: string; refusal: Omit<ParseRefusedResource, 'filePath'>; error: Error }
  | { outcome: 'failed'; error: unknown };

/**
 * A refusal a warm run's store states for a file (`AdmittedFacts`'s
 * `not-admitted`), as the preparation the cold lane makes for the same file:
 * the same log, reason and code, so the finding is the cold one.
 *
 * The error is what a single-file add throws for it, rebuilt as the cold lane's
 * class, since no read raised one. A store states two refusals and no other
 * (per-run refusals are never stored, and every other unadmitted state is
 * computed: `stored-admission.ts`): the input cap, the cold read's
 * `ParseLimitError`; and a parser's throw, branded as the parser's
 * (`isParserThrewError`) under its stored code, its message the stored reason.
 *
 * @param filePath - The file, as the caller named it
 * @param stated - The stored entry
 * @returns The preparation
 */
function statedRefusal(filePath: string, stated: NotAdmittedEntry): PreparedResource {
  if (stated.log === 'parseRefused') {
    return parseRefusedPreparation(filePath, stated.entry, new ParseLimitError('inputBytes', POPULATION_PARSE_LIMITS.inputBytes));
  }
  const { reason, code } = stated.entry;
  return {
    outcome: 'unreadable',
    filePath,
    reason,
    ...(code !== undefined && { code }),
    error: reviveParserThrow({ name: 'Error', message: reason, ...(code !== undefined && { code }) }, true),
  };
}

/**
 * @param filePath - The file, as the caller named it
 * @param refusal - What refused its parse for this run, as the log states it
 * @param error - What a single-file add throws for it
 * @returns The parse-refused preparation, cold or stated alike
 */
function parseRefusedPreparation(filePath: string, refusal: Omit<ParseRefusedResource, 'filePath'>, error: Error): PreparedResource {
  return { outcome: 'parse-refused', filePath, refusal, error };
}

/**
 * One enumerated file whose parse this run refused — stopped at a limit, or lost
 * with the worker that held it — and so is absent from the registry despite the
 * crawl having found it. Never stored: the next run parses it again (ADR I6).
 *
 * The one shape every lane reports a refusal from — a crawl's log, a
 * single-file add's throw, and a projection's refusal rows alike — so
 * `parseRefusedMessage` says it in one sentence wherever it was met.
 */
export interface ParseRefusedResource {
  /** Absolute path of the file that was enumerated but not admitted. */
  readonly filePath: string;
  /** The finding code every consumer reports it under. */
  readonly code: 'RESOURCE_PARSE_LIMIT_EXCEEDED' | 'RESOURCE_PARSE_WORKER_DIED';
  /** What stopped the parse, e.g. `its parse was stopped at its stackMb limit (1 MiB stack)`. */
  readonly reason: string;
}

export class DuplicateResourceIdError extends VatError {
  readonly id: string;
  readonly existingPath: string;
  readonly conflictingPath: string;

  constructor(id: string, conflictingPath: string, existingPath: string) {
    super('DUPLICATE_RESOURCE_ID', `Duplicate resource ID '${id}': '${conflictingPath}' conflicts with '${existingPath}'`);
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
 * What a resource crawl excludes when the caller supplies no `exclude` of its own:
 * only what can never be authored content (`NEVER_CONTENT_GLOBS` — dependencies, git
 * internals, worktree copies, a build's staging residue) and build output. Not
 * `coverage/` or `.turbo/`, which an author may name a directory. A caller's
 * `exclude` REPLACES it; spread this to keep it. Exported for the same reason as
 * {@link DEFAULT_RESOURCE_INCLUDE}: one home, never a restated copy.
 */
export const DEFAULT_RESOURCE_EXCLUDE: readonly string[] = Object.freeze([...NEVER_CONTENT_GLOBS, ...BUILD_OUTPUT_GLOBS]);

/**
 * Refuse an omitted `unreadable` up front, by name, before any directory is listed.
 *
 * The type makes the field required and that enumerates the TypeScript callers;
 * this is the runtime half for the callers the type cannot reach (test files
 * are not typechecked by the build, a JS adopter has no compiler). Surfacing it
 * only on the first refusal would let a tree with nothing unreadable keep
 * returning complete lists — the optional seam back again, one layer down.
 *
 * @param policy - What the caller passed as `unreadable`
 */
function requirePopulationUnreadablePolicy(
  policy: PopulationUnreadablePolicy | undefined,
): asserts policy is PopulationUnreadablePolicy {
  if (policy === undefined) {
    throw new TypeError(
      "ResourceRegistry.crawl: `unreadable` is required — pass 'refuse' to stop on a directory the crawl cannot list, "
      + 'or { degrade: (refusal) => … } to keep going and report the gap yourself.',
    );
  }
}

/**
 * Options for crawling directories to add resources.
 */
export interface CrawlOptions {
  /** Base directory to crawl */
  baseDir: string;
  /**
   * What to do with a directory inside the population the crawl cannot list —
   * see {@link PopulationUnreadablePolicy}. Required, no default. Handed to the
   * population source: `'refuse'` stops the run by name, `{ degrade }` keeps the
   * readable remainder and hands each refusal over. A directory inside ignored
   * territory is recorded as a population condition under either policy, when
   * {@link CrawlOptions.ignoredRefusals} is `record`.
   */
  unreadable: PopulationUnreadablePolicy;
  /** Include patterns (default: {@link DEFAULT_RESOURCE_INCLUDE}) */
  include?: string[];
  /** Exclude patterns, replacing the default (default: {@link DEFAULT_RESOURCE_EXCLUDE}) */
  exclude?: string[];
  /**
   * The trees the calling verb WRITES — its output and the staging it builds it in — or `[]`
   * for a verb that only reads: the one declaration of which side a fault is on. A fault at
   * (or a refused listing of) a directory that is, lies in, or holds one of them — the base of
   * a project the verb writes into included — is the destination's; anything else the input's.
   * Required: only the caller knows, and a default would put every omitted caller's output
   * faults on the input.
   */
  outputs: readonly string[];
  /**
   * Where the file list comes from: the run's population. Required — there is
   * no other lane.
   *
   * The source answers ENUMERATION only. `include`/`exclude` are applied here,
   * with {@link crawlPathFilter}, to whatever the source offers. A run's source
   * answers any root it is asked about under that root's own oracles (see
   * `ResourcePopulationSource`), so a crawl of a root other than the run's home
   * is enumerated for that root: nothing declines and nothing walks.
   */
  populationSource: ResourcePopulationSource;
  /**
   * Whether this crawl's caller reports the directories it could not list inside
   * ignored territory (see `PopulationMembers.ignoredRefusals`). Required: a
   * caller that reports them and omitted it would lose them with the store off,
   * and one that drops them would pay for a walk of every ignored directory.
   */
  ignoredRefusals: IgnoredRefusals;
}

/**
 * What one {@link ResourceRegistry.crawl} admitted, and where its population came from.
 */
export interface RegistryCrawl {
  /** The admitted resources, in admission order — see {@link admissionOrder}. */
  readonly resources: ResourceMetadata[];
  /** The enumeration's own outcome and enumerator. */
  readonly population: CrawlPopulation;
}

/**
 * The ONE order the registry admits files in: by resolved path, in UTF-16
 * code-unit order (`compareCodeUnits`).
 *
 * First-added-wins on a duplicate id is decided by admission order, so the
 * order belongs to the registry and not to whoever enumerated. Its scope is ONE
 * admission batch — an {@link ResourceRegistry.addResources} call, so a whole
 * crawl — and never evicts a file an earlier batch registered; a caller that
 * admits a batch one {@link ResourceRegistry.addResource} at a time (the
 * packager's bundled assets) orders it through this same function first: a walk lists by
 * directory, git lists by byte, a stored extent comes back in SQLite's order,
 * and each would keep a different file. Code-unit order equals git's UTF-8 byte
 * order except where a character above U+FFFF meets one in U+E000–U+FFFF.
 *
 * @param filePaths - The files to admit, in any order and any spelling
 * @returns A new array in admission order; the input is not reordered
 */
export function admissionOrder(filePaths: readonly string[]): string[] {
  return filePaths
    .map((filePath) => ({ filePath, key: safePath.resolve(filePath) }))
    .sort((left, right) => compareCodeUnits(left.key, right.key))
    .map(({ filePath }) => filePath);
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
  /**
   * How, and whether, to move this registry's parsing off the main thread.
   *
   * Defaults are what a command gets — there is no off switch — and the
   * meaning of every field is {@link ParsePoolPolicy}'s, shared verbatim with
   * the projection lane so the two cannot reach different verdicts about a
   * switch that has already been measured once.
   *
   * ⚠️ **A policy is per `addResources` call, not per registry.** The dispatcher
   * is built and shut down inside each call, because a pool that outlived one
   * would have to be closed by an explicit lifecycle method this class does not
   * have, and every existing caller would leak its workers. `crawl()` makes
   * exactly one `addResources` call, so a crawling command builds exactly one
   * pool — the same lifetime `populateBlobs` has.
   */
  parsePool?: ParsePoolPolicy;
}

/**
 * How a registry admits a file: reads, keys, parses and stats it.
 *
 * Two routes, one per lifetime, and no third:
 *
 * - A registry of its own (`new ResourceRegistry`) admits directly: every call
 *   reads the file afresh, and each admission batch parses on a dispatcher it
 *   builds and shuts down. Re-adding a path is a refresh.
 * - A registry of a run (`ResourceRegistry.forRun`, and every `view` of it)
 *   admits through the run's population: one read, key, parse and stat per file
 *   for the whole run, on the run's dispatcher, which the run's owner shuts down.
 */
interface AdmissionRoute {
  /**
   * One file's admission facts.
   *
   * @param absolutePath - The file, resolved
   * @param parserKind - The parser its content routes to
   * @param compute - Computes the facts from a read
   */
  admit(absolutePath: string, parserKind: ParserKind, compute: () => Promise<AdmittedFacts>): Promise<AdmittedFacts>;
  /**
   * One file's stat, its link chain read beneath `statRoot`.
   *
   * @param absolutePath - The file, resolved
   * @param statRoot - The root its link chain is read beneath
   * @param compute - Stats the file
   */
  stat(absolutePath: string, statRoot: string, compute: () => Promise<AdmittedStat>): Promise<AdmittedStat>;
  /** Read and key one file under the population's input cap. */
  read<K extends ParserKind>(absolutePath: string, parserKind: K): Promise<KeyedContent<K>>;
  /** Run one admission batch on a dispatcher. */
  withDispatcher<T>(work: (dispatcher: ParseDispatcher) => Promise<T>): Promise<T>;
}

/** The route of a registry of its own — see {@link AdmissionRoute}. */
function directAdmission(dispatcherFor: () => ParseDispatcher): AdmissionRoute {
  return {
    admit: (_absolutePath, _parserKind, compute) => compute(),
    stat: (_absolutePath, _statRoot, compute) => compute(),
    read: (absolutePath, parserKind) => readContentWithKey(absolutePath, parserKind, POPULATION_PARSE_LIMITS.inputBytes),
    async withDispatcher(work) {
      const dispatcher = dispatcherFor();
      try {
        return await work(dispatcher);
      } finally {
        // ⚠️ In a `finally`, and it must stay there. `pool.shutdown()` is what
        // closes each worker's port gracefully so its `exit` listeners run and its
        // parse-timing dump reaches disk; a run that threw past this would leave
        // live threads, and a process that exits with live threads runs none of
        // their exit listeners. See `parse-pool.ts` — `terminate()` is not
        // shutdown.
        await dispatcher.shutdown();
      }
    },
  };
}

/** The route of a run's registry — see {@link AdmissionRoute}. */
function runAdmission(population: RunPopulation): AdmissionRoute {
  return {
    admit: (absolutePath, parserKind, compute) => population.admit(absolutePath, parserKind, compute),
    stat: (absolutePath, statRoot, compute) => population.stat(absolutePath, statRoot, compute),
    read: async (absolutePath, parserKind) => {
      const keyed = await population.content.read(absolutePath, parserKind);
      // The cache files an entry under its `(path, parserKind)` pair, so an entry
      // found under this kind was read for this kind.
      return keyed as KeyedContent<typeof parserKind>;
    },
    withDispatcher: (work) => work(population.dispatcher),
  };
}

/**
 * The key under which a view is built: a module-private constructor option, so a
 * view shares its run's admissions and is not counted as a registry built, and
 * no caller outside this module can make a registry that does either.
 */
const VIEW_OF: unique symbol = Symbol('view-of');

/** The constructor's options, with the module-private route a view and a run registry carry. */
type ConstructionOptions = ResourceRegistryOptions & { readonly [VIEW_OF]?: { readonly route: AdmissionRoute; readonly counted: boolean } };

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
 * await registry.crawl({
 *   baseDir: '/project/docs',
 *   unreadable: 'refuse',
 *   outputs: [],
 *   populationSource: run.population.source, // the run's population (ResourcePopulationSource)
 *   ignoredRefusals: 'record',
 * });
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
  private fsCache: FsLookupCache = new FsLookupCache(locationRoot(undefined));

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
   * This registry's parse routing, built once from its own config.
   *
   * ## Why the registry gets its OWN instance rather than sharing the run's
   *
   * A registry is constructed with a config and lives as long as its caller; a
   * `populate()` run builds a resolver whose lifetime is that one run. There is
   * no scope that contains both, and threading the projection's instance in
   * would tie a registry's correctness to whether a population happened to be
   * in flight.
   *
   * That is not the "parallel resolver" CLAUDE.md bans — this is the SAME
   * routing constructor (`parseRoutingFor`), called twice, not a second implementation of
   * the rule. What differs per instance is only the conflict accumulator, and
   * that is correct: the projection lane reports conflicts as
   * `realization_conditions` rows, while `ResourceMetadata` has nowhere to put
   * one. This lane resolves the conflict the same way (the built-in table's
   * answer) and stays silent about it, which is the same posture it already
   * takes for `measureContent` and the raw-source lexer.
   *
   * ⚠️ Without this the two lanes DIVERGE the moment anyone declares a
   * `mimeType`: the projection would parse a `.ts` typed `text/markdown` and the
   * registry would leave it unparsed. Not a mis-filing — the kind is in the
   * digest preimage, so the two would compute different KEYS and neither could
   * serve the other's facts — but two answers to "is this file prose" is one too
   * many.
   */
  private mimeResolverInstance?: CollectionMimeResolver | undefined;

  /**
   * Which of this registry's collections a file belongs to: its collections'
   * patterns compiled once, on the first admission, never once per file. The
   * config is fixed at construction, so nothing invalidates it.
   */
  #collectionsFor: ((filePath: string) => string[]) | undefined;

  /**
   * This registry's parse-pool policy — see {@link ResourceRegistryOptions.parsePool}.
   *
   * Held rather than passed, because `crawl()` reaches `addResources` and a
   * per-call parameter would make the policy a property of the deepest caller
   * instead of a property of the registry.
   */
  private readonly parsePoolPolicy: ParsePoolPolicy = {};

  /** How this registry admits a file — see {@link AdmissionRoute}. */
  readonly #admission: AdmissionRoute;

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
   * a missing `resolvedId` then costs at packaging time. One of the three sites of the
   * enumerated-vs-derived path class, collected in docs/architecture/resource-scanning-and-caching.md §3.6.
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
  private readonly resourcesByContentKey: Map<ContentKey, ResourceMetadata[]> = new Map();

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
   * Files whose parse this run refused (`parse-limits.ts`): stopped at a limit,
   * or lost with the worker that held it. Not admitted this run. Cleared by
   * clear(). Surfaced as RESOURCE_PARSE_LIMIT_EXCEEDED or
   * RESOURCE_PARSE_WORKER_DIED issues in validate(). Nothing about them is
   * stored, so the next run parses them again.
   */
  private parseRefusedResources: ParseRefusedResource[] = [];

  /**
   * Population-time conditions the population source handed over with the
   * paths — the projection's `realization_conditions` for the extents the
   * population registered. Cleared by
   * clear(). Surfaced by validate(), one finding per `(code, path)`, with the
   * row's own severity — see {@link collectPopulationConditionIssues}.
   */
  private populationConditions: readonly RealizationConditionRow[] = [];

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
   * Files whose parse this run refused, in the order `addResources` met them.
   *
   * ⛔ Not optional to read. Such a file is in no other list this registry
   * keeps: not admitted, not unreadable, not in `getAllResources()`. A consumer
   * that crawls and never calls {@link validate} must report every entry here
   * as an error finding and count it as examined, exactly as it reports
   * {@link getUnreadableResources}; otherwise a pathological document silently
   * drops out of its output at exit 0. Every crawl in `src` is held to this by
   * `packages/dev-tools/test/parse-refusal-readers.test.ts`.
   *
   * @returns A copy of the refusal log, oldest first
   */
  getParseRefusedResources(): ParseRefusedResource[] {
    return [...this.parseRefusedResources];
  }

  /**
   * Both logs of files this registry enumerated and did not admit
   * ({@link getUnreadableResources}, {@link getParseRefusedResources}), in the
   * shape the one not-admitted contract reads (`not-admitted.ts`): every verb
   * turns them into findings and counts them in `examined` through it.
   *
   * @returns Copies of both logs
   */
  getNotAdmitted(): NotAdmittedLog {
    return { unreadable: this.getUnreadableResources(), parseRefused: this.getParseRefusedResources() };
  }

  /**
   * Duplicate-id drops, in the order `addResources` made them.
   *
   * Exposed because admission order is behaviour, not bookkeeping: the rule is
   * first-added-wins, so which of two colliding files gets validated, bundled
   * and rewritten is decided by admission order (see {@link admissionOrder}),
   * which is the registry's own and not the enumerator's. `validate()` turns these
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
    const shared = (options as ConstructionOptions | undefined)?.[VIEW_OF];
    // A view reads its run's admissions: it is not a registry built.
    if (shared === undefined || shared.counted) countWork('registry.built', 1);
    this.#admission = shared?.route
      ?? directAdmission(() => new ParseDispatcher(this.parseCache(), this.parsePoolPolicy));
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
    if (options?.parsePool !== undefined) {
      this.parsePoolPolicy = options.parsePool;
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
   * The registry of a run: it admits through the run's population (one read, key,
   * parse and stat per file for the whole run, on the run's dispatcher), and each
   * phase of the run reads a {@link view} of it. Counted once as a registry built.
   *
   * @param population - The run's population
   * @param options - The registry's options; its parse cache and pool are the run's
   * @returns The run's registry
   */
  static forRun(population: RunPopulation, options: Omit<ResourceRegistryOptions, 'parseCache' | 'parsePool'>): ResourceRegistry {
    const construction: ConstructionOptions = { ...options, [VIEW_OF]: { route: runAdmission(population), counted: true } };
    return new ResourceRegistry(construction);
  }

  /**
   * A view of this registry's run: a registry with its own base directory,
   * config and finding lists that admits through the same admissions.
   *
   * Everything that depends on the view is computed by the view, by the same
   * code as any registry: the id (against the view's base directory), first-wins
   * duplicate detection in the view's admission order, link resolution,
   * population conditions and parse refusals. What it shares is per-file only —
   * the read, the key, the parse, the size and the stat — and the links it is
   * handed are copied, so no two views share a link object.
   *
   * Not counted as a registry built (`registry.built`): it reads its run's
   * admissions. A view of a registry of its own admits directly, as that
   * registry does.
   *
   * @param options - The view's options; the parse cache and pool are its run's
   * @returns The view
   */
  view(options: Omit<ResourceRegistryOptions, 'parseCache' | 'parsePool'>): ResourceRegistry {
    const construction: ConstructionOptions = { ...options, [VIEW_OF]: { route: this.#admission, counted: false } };
    return new ResourceRegistry(construction);
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
   * Initializes all indexes (by path, ID, name, content key) from the provided resources.
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
   * Combines registry creation and directory crawling in a single operation,
   * and returns what {@link ResourceRegistry.crawl} returned beside the
   * registry — one route to a crawl, one shape for its answer, so a caller built
   * here can say which lane enumerated exactly as a `crawl()` caller can.
   *
   * @param crawlOptions - Crawl options including baseDir
   * @param registryOptions - Additional registry options
   * @returns The new registry, and the crawl's resources and population
   *
   * @example
   * ```typescript
   * const { registry, population } = await ResourceRegistry.fromCrawl({
   *   baseDir: '/project/docs',
   *   outputs: [],
   *   unreadable: 'refuse', // or { degrade } — see PopulationUnreadablePolicy
   *   populationSource: run.population.source, // the run's population (ResourcePopulationSource)
   *   ignoredRefusals: 'record', // or 'skip' — see PopulationMembers.ignoredRefusals
   *   include: ['**.md'],
   *   exclude: ['node_modules'],
   * });
   * console.log(`Crawled ${registry.size()} resources (population: ${population.outcome.population})`);
   * ```
   */
  static async fromCrawl(
    crawlOptions: CrawlOptions,
    registryOptions?: Omit<ResourceRegistryOptions, 'baseDir'>,
  ): Promise<RegistryCrawl & { readonly registry: ResourceRegistry }> {
    const registry = new ResourceRegistry({ ...registryOptions, baseDir: crawlOptions.baseDir });
    return { registry, ...(await registry.crawl(crawlOptions)) };
  }

  /**
   * Add a single resource to the registry.
   *
   * Parses the file, generates a unique ID, and stores the resource. Costs
   * exactly one `readFile` and one `stat` per file — the parse, the content key
   * and the size all come off that single pair. The parse itself may be served from
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
    // Through the admission route's dispatcher, so this route and `addResources`
    // reach the parser through exactly one code path: a miss parses in a bounded
    // worker (I8). A hit spawns nothing.
    try {
      const prepared = await this.#admission.withDispatcher((dispatcher) => this.prepareAdmission(filePath, dispatcher));
      // ⛔ Deliberately NOT routed through `emitPreparedResource`. This entry
      // point has no finding list to route into — it throws, as it always has —
      // and sending a read failure through emission would additionally record a
      // `RESOURCE_UNREADABLE` finding that a direct `addResource` caller never
      // used to get. `unreadable` carries the original error precisely so this
      // route can re-raise it unchanged; a refusal a warm run's store states
      // carries the same class rebuilt (`statedRefusal`).
      if (prepared.outcome !== 'admitted') throw prepared.error;
      return this.indexAdmitted(prepared.resource);
    } finally {
      recordRegistryPass(CRAWL_REGISTRY_ADMIT_ID, startedAt);
    }
  }

  /**
   * Read, parse, key and measure one file, **deciding everything and recording
   * nothing.**
   *
   * ⛔ It must stay free of side effects on this registry's indexes and finding
   * lists. This is the half that runs concurrently — see {@link driveInOrder} —
   * so an `indexResource` call here would order the 1:many indexes by which read
   * finished first, and a `duplicateIdCollisions.push` here would adjudicate
   * against a `resourcesById` that has not been filled in yet.
   *
   * ⛔ **And it must not reject.** `driveInOrder` would catch the rejection and
   * re-raise it in target order, so the run's fate would still be deterministic
   * — but it would be a *failed run*, and most of what can go wrong here is a
   * FINDING: an unreadable file is recorded and crawled past. Only this function
   * knows which is which, so every outcome — including a genuine defect — is
   * carried back as a value for {@link emitPreparedResource} to act on.
   *
   * @param filePath - Path to the file (will be normalized to absolute)
   * @param dispatcher - Decides whether the parse runs here or on a worker
   * @returns What this file turned out to be, for the caller to emit in order
   */
  private async prepareAdmission(
    filePath: string,
    dispatcher: ParseDispatcher,
  ): Promise<PreparedResource> {
    try {
      const prepared = await this.readAndKey(filePath, dispatcher);
      return 'notAdmitted' in prepared ? statedRefusal(filePath, prepared.notAdmitted) : { outcome: 'admitted', resource: prepared };
    } catch (error) {
      // A parse stopped at a limit, or lost with its worker, is the run's, not
      // the file's or VAT's: a finding, so one runaway document never fails the
      // whole crawl (ADR I6, I8).
      if (isPerRunParseRefusal(error)) return parseRefusedPreparation(filePath, parseRefusal(error), error);
      // The parser threw on these bytes: a fact of the document, so the file is
      // unreadable under the parser's code - exactly as the blob lane records a
      // `BLOB_PARSE_FAILED` row (`parseFailedEntry`, one rule for both lanes) -
      // never a failed run.
      if (isParserThrewError(error)) {
        const entry = parseFailedEntry(parseFailedMessage(this.parserKindFor(safePath.resolve(filePath)), error));
        return { outcome: 'unreadable', filePath, ...entry, error };
      }
      if (isReadFailure(error)) {
        // A file the crawl handed us that we cannot read. Recorded, not thrown:
        // previously this terminated `vat resources scan|validate` and `vat
        // audit` with a raw ENOENT stack trace, which a committed dangling
        // `*.md` symlink reaches on `crawlDirectory`'s git route (that route
        // returns mode-120000 entries and does no symlink filtering).
        //
        // ⛔ Recorded rather than skipped, deliberately. Swallowing the read
        // would trade a loud crash for a silent population change — the file
        // would vanish from every downstream count with nothing said. It
        // becomes a RESOURCE_UNREADABLE issue in validate().
        return {
          outcome: 'unreadable',
          filePath,
          reason: error.message,
          error,
          code: readFailureCode(error),
        };
      }
      // Not a per-file read failure: a genuine defect in parsing, which must not
      // be demoted to a finding, or a fault that is not the file's (the machine out
      // of descriptors, disk or quota; a failing device) — classified here, at the
      // read, so it refuses by the table rather than as a raw errno. Carried, not
      // thrown — see the docblock.
      return { outcome: 'failed', error: classifyFsFault(error, { side: 'source', origin: 'content', action: `read ${filePath}`, path: filePath }) };
    }
  }

  /**
   * Which document parser, if any, this path routes to.
   *
   * @param absolutePath - The resolved path to route
   * @returns The parser kind, or `none` when nothing parses this type
   */
  private parserKindFor(absolutePath: string): ParserKind {
    // Routed through the run's resolver, never the path-only `parserKindForPath`,
    // so this lane reaches the projection lane's verdict.
    //
    // ONE authority, deliberately: the read's parser selection and the
    // sizing tally in {@link addResources} must be the same answer. Parser
    // selection is part of a document's parse identity (content-key.ts), so a
    // second resolver here is how the parse route and the key's parse-route
    // component drift apart.
    // The resolver is kept (its conflict accumulator is this registry's); the base directory is read
    // per call, because a crawl may set it after an earlier `addResource` built the resolver.
    this.mimeResolverInstance ??= parseRoutingFor(this.config, this.baseDir).resolver;
    return parserKindForResolvedPath(absolutePath, this.mimeResolverInstance, this.baseDir);
  }

  /**
   * This registry's parse cache, built on first use.
   *
   * Lazy for the reason {@link parseCacheInstance} records: `ParseCache` reads
   * `VAT_CACHE` once per construction, so building it eagerly would bind that
   * decision to registry-construction time.
   *
   * @returns The cache every parse on this lane consults
   */
  private parseCache(): ParseCache {
    this.parseCacheInstance ??= new ParseCache();
    return this.parseCacheInstance;
  }

  /**
   * Read, parse, key and measure one file, or take the run's stored answer for
   * it. The body of a preparation, minus its classification of what went wrong.
   *
   * @param filePath - Path to the file (will be normalized to absolute)
   * @param dispatcher - Decides whether the parse runs here or on a worker
   * @returns The resource this file describes — **not yet indexed** — or the
   *   refusal a warm run's store states for it
   * @throws Whatever the read or the parse threw
   */
  private async readAndKey(
    filePath: string,
    dispatcher: ParseDispatcher,
  ): Promise<ResourceMetadata | { readonly notAdmitted: NotAdmittedEntry }> {
    // Normalize path to absolute
    const absolutePath = safePath.resolve(filePath);
    const parserKind = this.parserKindFor(absolutePath);
    const statRoot = locationRoot(this.baseDir);
    // The per-file facts: this run's, when it has already admitted the file in
    // another view or the store holds them, or computed here. See
    // {@link AdmissionRoute}.
    const admitted = await this.#admission.admit(absolutePath, parserKind, () =>
      this.admitFacts(absolutePath, parserKind, dispatcher),
    );
    if (admitted.kind === 'not-admitted') return { notAdmitted: admitted.entry };
    // The facts are shared, one frozen answer per content key, with every other
    // view of the run, every identically-contented file and the population that
    // keyed it. A view writes two things in place, so it takes its OWN copy of
    // exactly those: the links (`resolveLinks` sets each link's `resolvedId`
    // against this view's ids; the packager rewrites links while bundling) and
    // the headings. The rest stays shared. Built the same way whether the facts
    // came from a cold parse (`blobResourceFactsOf`) or the store.
    const facts = admitted.facts;
    const links: ResourceLink[] = facts.links.map((link) => ({ ...link }));
    const headings = structuredClone(facts.headings);

    // THE stat — one call serving both `modifiedAt` and `sizeBytes`, its link
    // chain read beneath the crawl base first (`link-following.ts`). After the
    // read and parse, so a file that cannot be read costs no stat.
    const stats = await this.#admission.stat(absolutePath, statRoot, () => {
      countWork('fs.stat', 1);
      return requireFollowedStat(absolutePath, statRoot);
    });

    // Generate ID using priority chain: frontmatter field → relative path → filename stem
    const id = this.generateId(absolutePath, facts.frontmatter);

    // Determine collections if config is present
    const configured = this.config?.resources?.collections;
    if (configured !== undefined) {
      this.#collectionsFor ??= compileCollectionMembership(configured);
    }
    const collections = this.#collectionsFor?.(absolutePath);

    // Create resource metadata
    const resource: ResourceMetadata = {
      id,
      filePath: absolutePath,
      links,
      headings,
      ...optionalParseFacts(facts),
      // `stat().size` — the on-disk byte count, exactly as before. Never
      // `Buffer.byteLength(content)` or `content.length`: those measure the
      // decoded string, and this number reaches packaged-output accounting
      // (agent-skills/src/content-transform.ts) and adopter-visible rule
      // variables.
      sizeBytes: stats.size,
      estimatedTokenCount: facts.estimatedTokenCount,
      modifiedAt: stats.mtime,
      contentKey: facts.contentKey,
      ...(collections !== undefined && collections.length > 0 && { collections }),
    };

    return resource;
  }

  /**
   * Read, key and parse one file: its admission facts, and nothing that depends
   * on the registry admitting it. Counted once per file admitted
   * (`registry.admitted`): a view that is handed the facts again admits nothing.
   *
   * @param absolutePath - The resolved path
   * @param parserKind - The parser its content routes to
   * @param dispatcher - Decides whether the parse runs here or on a worker
   * @returns The file's admission facts
   * @throws Whatever the read or the parse threw
   */
  private async admitFacts(
    absolutePath: string,
    parserKind: ParserKind,
    dispatcher: ParseDispatcher,
  ): Promise<AdmittedFacts> {
    // THE read. Everything below is a function of these bytes, the content key
    // included.
    // The discriminator runs exactly ONCE here and its answer rides on `keyed`
    // into both the content key and the parser selection in the dispatcher:
    // parser selection is part of a document's parse identity (content-key.ts),
    // and running the discriminator twice is how the parse route and the key's
    // parse-route component drift apart.
    //
    // See {@link parserKindFor} for why the routing goes through the run's
    // resolver rather than `parserKindForPath`.
    // Held to the run's parse input cap by its size, before it is read (a kind
    // nothing parses is never capped: see `readContentWithKey`).
    const keyed = await this.#admission.read(absolutePath, parserKind);

    // Parse from the bytes already in hand — or from a cache entry filed under
    // the key those bytes just produced. See `ParseDispatcher.parse`.
    //
    // …unless the bytes are not text, or nothing parses this kind at all: the ONE
    // route both lanes take (`contentRoute`, projection/document-facts.ts), so a
    // binary `.md` is the same resource here as the blob lane's stored facts say.
    const route = contentRoute(keyed);
    const parseResult = route.kind === 'parse' ? await dispatcher.parse(route.content) : route.facts;

    countWork('registry.admitted', 1);
    return { kind: 'facts', facts: blobResourceFactsOf(parseResult, keyed.key) };
  }

  /**
   * Write one prepared file into the registry, and record what it turned out to
   * be.
   *
   * **THE sequential half.** Every mutation this class performs during a crawl
   * happens here, and it is called in admission order, which is what makes the
   * output a function of the corpus rather than of the machine. Three separate
   * guarantees rest on that, and only the first one is loud when it breaks:
   *
   * 1. **First-added wins** on a duplicate id. `resourcesById` is only correct
   *    to consult once every file ahead of this one has been emitted.
   * 2. The two finding lists stay in **attempt order**, which their own
   *    docblocks promise and which reaches a user as issue order.
   * 3. `resourcesByName` and `resourcesByContentKey` are **1:many arrays**, and
   *    `getResourcesByContentKey` / `getDuplicates` read their insertion order
   *    back. Nothing throws when these scramble — the answers simply become
   *    machine-dependent, which is the worst way for this to fail.
   *
   * @param prepared - What preparation concluded about one file
   * @returns The admitted resource, or `undefined` when a finding was recorded
   *   instead
   * @throws Whatever preparation carried back as a genuine defect, and
   *   {@link DuplicateResourceIdError} for a losing id
   */
  private emitPreparedResource(prepared: PreparedResource): ResourceMetadata | undefined {
    if (prepared.outcome === 'failed') throw prepared.error;
    if (prepared.outcome === 'parse-refused') {
      this.parseRefusedResources.push({ filePath: prepared.filePath, ...prepared.refusal });
      return undefined;
    }
    if (prepared.outcome === 'unreadable') {
      this.unreadableResources.push({
        filePath: prepared.filePath,
        reason: prepared.reason,
        ...(prepared.code !== undefined && { code: prepared.code }),
      });
      return undefined;
    }
    return this.indexAdmitted(prepared.resource);
  }

  /**
   * Adjudicate one prepared resource's id and index it.
   *
   * ⛔ **Only correct to call once every file ahead of this one has been
   * emitted** — `resourcesById` is what "first-added wins" is decided against,
   * and it is not yet filled in while preparations are still in flight.
   *
   * @param resource - The candidate preparation produced
   * @returns The same resource, now indexed
   * @throws {DuplicateResourceIdError} If another path already holds this id
   */
  private indexAdmitted(resource: ResourceMetadata): ResourceMetadata {
    // Re-adding the SAME path is not a collision — it is a refresh, and it was
    // never one on the sequential path either.
    const existingById = this.resourcesById.get(resource.id);
    if (existingById && existingById.filePath !== resource.filePath) {
      throw new DuplicateResourceIdError(resource.id, resource.filePath, existingById.filePath);
    }

    this.indexResource(resource);
    return resource;
  }

  /**
   * Add multiple resources to the registry: read and parse with a bounded
   * fan-out, then register in admission order (see {@link admissionOrder}).
   *
   * ## Why this is no longer a sequential loop
   *
   * It was one, and its docstring justified that with *"Sequential execution
   * ensures deterministic duplicate ID detection"*. That constraint is real and
   * it is unchanged — what changed is where it is discharged. Reading and
   * parsing happen concurrently in {@link prepareAdmission}, which decides
   * everything and mutates nothing; every mutation happens in
   * {@link emitPreparedResource}, in admission order. So duplicate detection
   * is still strictly ordered while the parse — 70% of this command's wall clock
   * on a real adopter — is not.
   *
   * ⭐ **At width 1, which is what ships today, this is the old loop exactly**:
   * one file prepared, one file emitted, before the next is touched.
   *
   * @param filePaths - The file paths to add, in any order: the registry sorts
   *   them into admission order, so the code-unit-first of two paths with one id
   *   IN THIS CALL wins however the caller listed them. The order is per batch: a
   *   file an earlier call registered keeps its id, and a later path that sorts
   *   before it is the one recorded as the collision
   * @returns Array of parsed resource metadata, in admission order
   * @throws Error if any file fails for a reason that is not a read failure or
   *   a duplicate id — raised for the FIRST such file in admission order, not
   *   for whichever preparation happened to finish first
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
  async addResources(filePaths: readonly string[]): Promise<ResourceMetadata[]> {
    const ordered = admissionOrder(filePaths);
    // ⛔ Nothing is pre-loaded here, deliberately. A `loadParsersFor(filePaths)`
    // hoist stood on this line to keep a broken INSTALL out of the demotion
    // below, and it cost every fully warm crawl the ~730 ms remark load for
    // parses that never happen (measured: 963 scripts loaded on a warm scan,
    // against 779 with the parser absent). The demotion is guarded by TYPE
    // instead: `isReadFailure` allow-lists errnos, and a failed parser load
    // arrives as `ParserUnavailableError` whose code is not one, so it is
    // carried back as `failed` and re-thrown.
    const startedAt = crawlTimingStart();
    const results: ResourceMetadata[] = [];
    try {
      await this.#admission.withDispatcher((dispatcher) => driveInOrder(
        ordered,
        dispatcher,
        (filePath) => this.prepareAdmission(filePath, dispatcher),
        (prepared) => {
          try {
            const admitted = this.emitPreparedResource(prepared);
            if (admitted !== undefined) results.push(admitted);
          } catch (error) {
            if (!(error instanceof DuplicateResourceIdError)) throw error;
            this.duplicateIdCollisions.push({
              id: error.id,
              existingPath: error.existingPath,
              conflictingPath: error.conflictingPath,
            });
            // First-added wins; skip conflicting file and continue crawling.
          }
        },
        // ⭐ No I/O. The routing is a function of the path and this registry's
        // collection declarations, both already in memory, so this answers
        // without a `stat` and without a read.
        (from) =>
          tallyParsable(ordered, from, (filePath) =>
            this.parserKindFor(safePath.resolve(filePath)),
          ),
      ));
    } finally {
      recordRegistryPass(CRAWL_REGISTRY_ADMIT_ID, startedAt);
    }
    return results;
  }

  /**
   * Crawl a directory and add all matching markdown files, as ONE
   * {@link addResources} batch — so the whole crawl is admitted in one
   * admission order, however the files were enumerated.
   *
   * @param options - Crawl options (baseDir, the required `unreadable` policy, include, exclude patterns)
   * @returns The admitted resources, in admission order, and the outcome and
   *   enumerator the population's enumeration carried
   *
   * @example
   * ```typescript
   * // Crawl docs directory, excluding node_modules
   * const { resources, population } = await registry.crawl({
   *   baseDir: './docs',
   *   outputs: [],
   *   unreadable: 'refuse',
   *   populationSource: run.population.source, // the run's population (ResourcePopulationSource)
   *   ignoredRefusals: 'record',
   *   include: ['**\/*.md'],
   *   exclude: ['**\/node_modules/**']
   * });
   * ```
   */
  async crawl(options: CrawlOptions): Promise<RegistryCrawl> {
    const {
      baseDir,
      include = [...DEFAULT_RESOURCE_INCLUDE],
      exclude = [...DEFAULT_RESOURCE_EXCLUDE],
      unreadable,
      populationSource,
      outputs,
      ignoredRefusals,
    } = options;
    requirePopulationUnreadablePolicy(unreadable);

    // Propagate baseDir to registry if not already set (enables path-relative IDs)
    if (baseDir && !this.baseDir) {
      this.baseDir = baseDir;
    }

    // The enumeration ALONE is charged here, not the whole method: `addResources`
    // below charges itself per file (see {@link addResource}), and a bracket
    // around both would produce a row that contains the other one.
    //
    // ⚠️ The population's `base` rows (`builtin:filesystem`,
    // `blob-population:derive`) are NESTED INSIDE this one, not additive to it.
    // `withOuterBracket` is what makes that true of the DUMP and not only of
    // this comment: the driver-placed rows inside arrive at `CRAWL_PASS_INSIDE`,
    // where the classification already calls them nested and the renderer keeps
    // them out of the total. See `crawl-timing.ts` on stratum inheritance.
    const enumerationStartedAt = crawlTimingStart();
    const { admitted, enumeration } = await withOuterBracket(() =>
      this.populationFrom(populationSource, baseDir, { include, exclude, ignoredRefusals }, outputs, unreadable),
    );
    recordRegistryPass(CRAWL_REGISTRY_ENUMERATE_ID, enumerationStartedAt);

    const population: CrawlPopulation = { outcome: enumeration.outcome, extentSource: enumeration.extentSource };
    return { resources: await this.addResources(admitted), population };
  }

  /**
   * Narrow the population of this crawl's base directory to what its globs admit.
   *
   * The source enumerates a ROOT; `include`/`exclude` are declared relative to
   * the crawl's `baseDir`, and the source is asked about `baseDir` itself, so the
   * two coincide by construction.
   *
   * @param source - The run's population source
   * @param baseDir - The basis the caller's globs are written against, and the root enumerated
   * @param members - The crawl's globs and whether it reports ignored-territory refusals
   * @param outputs - The trees the calling verb writes
   * @param unreadable - What a refused listing inside the population does
   * @returns Absolute paths of the admitted files with the enumeration they came from
   */
  private async populationFrom(
    source: ResourcePopulationSource,
    baseDir: string,
    members: PopulationMembers,
    outputs: readonly string[],
    unreadable: PopulationUnreadablePolicy,
  ): Promise<{ admitted: string[]; enumeration: ResourceEnumeration }> {
    const base = safePath.resolve(baseDir);
    const { include, exclude } = members;
    const isMember = crawlPathFilter([...include], [...exclude]);
    const enumeration = await source.enumerate(base, outputs, unreadable, members);
    const { paths, conditions } = enumeration;
    // Kept whole, not narrowed by `include`/`exclude`: a condition is about the
    // enumeration, and a gap the enumerator met outside this crawl's globs is
    // still a gap in the population the projection will answer queries from.
    // ONE exception: a declined link the crawl's globs make none of its
    // business is dropped — the one rule, `declinedLinkApplies`, a listing
    // applies to its own view too.
    const linkApplies = declinedLinkApplies(exclude);
    this.populationConditions = conditions.filter(
      (row) => !isDeclinedSymlinkCode(row.code) || linkApplies(row.path),
    );
    const admitted: string[] = [];
    for (const absolutePath of paths) {
      if (isMember(safePath.relative(base, absolutePath))) {
        admitted.push(absolutePath);
      }
    }
    return { admitted, enumeration };
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
   * Surface every population-time condition as a finding — the projection's
   * rows the source handed over, plus the MIME conflicts THIS registry's own
   * resolver met while admitting files.
   *
   * ## Why the resolver's conflicts are read here and not only off the projection
   *
   * `COLLECTION_MIME_CONFLICT` was written as a `realization_conditions` row that
   * no command read, and this lane's docstring said it "stays silent about it":
   * two collections typing one file differently made every `vat resources` verb
   * exit 0 on both lanes. The registry resolves the type for every admitted file
   * itself (see {@link ResourceRegistry.mimeResolverInstance}), so its
   * accumulator is the witness that does not depend on whether the store
   * answered. The projection's row for the same file is folded onto it by the
   * `(code, path)` key below.
   *
   * ## What a row becomes
   *
   * An issue carrying the row's own code and severity, located at the row's
   * root-relative path. A code in the catalogue picks up its `fix` and
   * `reference` and is overridable through `severity.<CODE>`; the framework
   * passes any other code through unchanged, so a row is never dropped for
   * having a code this catalogue has not met — the row's severity stands.
   * @private
   */
  private collectPopulationConditionIssues(): ValidationIssue[] {
    const conflicts: Pick<RealizationConditionRow, 'code' | 'severity' | 'message' | 'path'>[] =
      (this.mimeResolverInstance?.conflicts ?? []).map((conflict) => ({
        path: conflict.path,
        ...collectionMimeConflictFinding(conflict),
      }));
    const seen = new Set<string>();
    const issues: ValidationIssue[] = [];
    for (const row of [...conflicts, ...this.populationConditions]) {
      const key = `${row.code}\0${row.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(populationConditionIssue(row));
    }
    return issues;
  }

  /**
   * RESOURCE_UNREADABLE, RESOURCE_PARSE_LIMIT_EXCEEDED and
   * RESOURCE_PARSE_WORKER_DIED errors for every file addResources() enumerated
   * and did not admit, through the one contract every verb reports them with
   * (`not-admitted.ts`). Unresolved: `validate()` runs the framework over them
   * with everything else.
   * @private
   */
  private collectNotAdmittedErrors(): ValidationIssue[] {
    return notAdmittedIssues(this.getNotAdmitted(), {
      locationRoot: locationRoot(this.baseDir),
      consequence: 'it was skipped: nothing in it was checked',
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

    // The files this run enumerated and did NOT admit — unreadable, or their
    // parse refused — as the judge's lookup: an anchor into one of them cannot
    // be checked, and the judge says so (LINK_TARGET_UNREADABLE) instead of
    // `skip`ping it as if the file held no headings. Built once from both logs
    // (`getNotAdmitted()`) — a view, not a second ledger.
    const unreadableTargets = unreadableTargetsFrom(this.getNotAdmitted());

    // Only pass options if projectRoot is defined (exactOptionalPropertyTypes requirement)
    const judgeOptions: JudgeLinkOptions = this.baseDir === undefined
      ? { ...tables, skipGitIgnoreCheck, checkHtmlAnchors, unreadableTargets }
      : {
          ...tables,
          projectRoot: this.baseDir,
          skipGitIgnoreCheck,
          checkHtmlAnchors,
          unreadableTargets,
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
      appendAll(issues, frontmatterIssues);
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

    // In order: issues follow resource order.
    await forEachInOrder(this.resourcesByPath.values(), async (resource) => {
      // Skip if resource has no collections
      if (!resource.collections || resource.collections.length === 0) {
        return;
      }

      // Validate against each collection's schema
      const collectionIssues = await this.validateResourceCollectionSchemas(
        resource,
        fs,
        fragmentsByFile,
        skipGitIgnoreCheck,
      );
      appendAll(issues, collectionIssues);
    });

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

    const collections = this.config.resources.collections;
    // In order: issues follow the resource's collection order.
    await forEachInOrder(resource.collections, async (collectionId) => {
      const collection = collections[collectionId];

      // Skip if collection has no validation or no schema
      if (!collection?.validation?.frontmatterSchema) {
        return;
      }

      const collectionIssues = await this.validateAgainstCollectionSchema(
        resource,
        collection.validation,
        fsModule,
        fragmentsByFile,
        skipGitIgnoreCheck,
      );
      appendAll(issues, collectionIssues);
    });

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

    const schemaSpecifier = validation.frontmatterSchema;
    const schemaFailure = (error: unknown): ValidationIssue[] => [
      createRegistryIssue(
        'FRONTMATTER_SCHEMA_ERROR',
        `Failed to load or parse frontmatter schema '${schemaSpecifier}': ${error instanceof Error ? error.message : String(error)}`,
        { location: issueLocation(resource.filePath, locationRoot(this.baseDir)), line: 1 },
      ),
    ];

    // A bare specifier that resolves to nothing (package not installed, or its
    // `exports` target not on disk) — or to a package Node cannot read (a
    // malformed package.json) — is the config's schema not loading, the same
    // finding as a schema path naming no file. Only those codes: any other
    // throw is not about the schema reference.
    let schemaPath: string;
    try {
      schemaPath = resolveAssetReference(schemaSpecifier, this.baseDir ?? process.cwd());
    } catch (error) {
      if (!isVatError(error, ASSET_REFERENCE_UNRESOLVED_CODE) && !isVatError(error, ASSET_REFERENCE_UNREADABLE_CODE)) throw error;
      return schemaFailure(error);
    }

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
    // (`realpathRowFrom`/`pathSpellingFrom` crash on a missing row so that a
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
      return schemaFailure(error);
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
      // Same lookup the body-link judge gets (see `validateAllLinks`), so a
      // frontmatter reference with an anchor into a locked file is a finding too.
      const unreadableTargets = unreadableTargetsFrom(this.getNotAdmitted());
      const linkOptions: ValidateLinkOptions = this.baseDir === undefined
        ? { fsCache: this.fsCache, skipGitIgnoreCheck, unreadableTargets }
        : {
            fsCache: this.fsCache,
            projectRoot: this.baseDir,
            skipGitIgnoreCheck,
            unreadableTargets,
            ...(this.gitTracker !== undefined && { gitTracker: this.gitTracker }),
          };

      const { issues: linkIssues, externalUrls } = await validateFrontmatterLinks(
        resource.frontmatter,
        compiled.schema,
        resource.filePath,
        fragmentsByFile,
        linkOptions,
      );
      appendAll(issues, linkIssues);

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
  private loadCollectionSchema(
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
    this.fsCache = new FsLookupCache(locationRoot(this.baseDir));

    // Build fragment index for anchor validation
    const fragmentsByFile = this.buildFragmentIndex();

    // Reset frontmatter external URL state for this validation run
    this.frontmatterExternalUrlsByResource.clear();

    // Collect all validation issues
    const issues: ValidationIssue[] = [];

    // Surface parse-time diagnostics: YAML frontmatter errors first, then HTML
    // well-formedness, then dangling reference-style links, then duplicate-id
    // collisions. Combined into one push() call (SonarCloud S7778).
    appendAll(issues, [
      ...this.collectYamlErrors(),
      ...this.collectHtmlParseErrors(),
      ...this.collectUnresolvedReferenceIssues(),
      ...this.collectDuplicateIdErrors(),
      ...this.collectNotAdmittedErrors(),
      ...this.collectPopulationConditionIssues(),
    ]);

    // Validate each link in each resource
    const linkIssues = await this.validateAllLinks(
      fragmentsByFile,
      options?.skipGitIgnoreCheck ?? false,
      options?.checkHtmlAnchors ?? false,
      options?.deferredArtifacts,
    );
    appendAll(issues, linkIssues);

    // Per-collection frontmatter validation
    const collectionFrontmatterIssues = await this.validateCollectionFrontmatter(
      fragmentsByFile,
      options?.skipGitIgnoreCheck ?? false,
    );
    appendAll(issues, collectionFrontmatterIssues);

    // Global frontmatter validation (if schema provided)
    if (options?.frontmatterSchema) {
      const mode = options.validationMode ?? 'strict';
      appendAll(issues, this.validateAllFrontmatter(options.frontmatterSchema, mode));
    }

    // External URL validation (if enabled)
    if (options?.checkExternalUrls) {
      const externalUrlIssues = await this.validateExternalUrls(options.noCache ?? false);
      appendAll(issues, externalUrlIssues);
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
    // shape (linkAuth design §5). When the adopter has no linkAuth config, the
    // validator skips the authenticated branch and uses the existing
    // markdown-link-check path for every URL — identical to pre-linkAuth behavior.
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
   * Never under `VAT_CACHE_DIR`: that directory is persistable, and a link
   * verdict must not ride a CI cache restore into the next run (see
   * `cache-root.ts`).
   *
   * @private
   */
  private getCacheDirectory(): string {
    return vatLinkCacheDirectory();
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

      // Prefer a code surfaced by the validator's authenticated branch (linkAuth design §7) —
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
   * ⚠️ **Unguarded, over a registry that may be shared by a whole batch.** This
   * takes no zone or scope parameter: it overwrites `resolvedId` on every
   * `local_file` link of every resource in the registry, including documents
   * belonging to some *other* skill. `packageSkills` in
   * `@vibe-agent-toolkit/agent-skills` (`skill-packager.ts`) builds exactly ONE
   * registry for the batch and hands it to every `packageSkill` call, and
   * `registerBundledAssets` calls `registry.addResource(assetPath)` and then
   * this method across the whole registry — once per skill, N times per batch.
   * So skill A bundling `foo.yaml` leaves skill B's link to that same file
   * already stamped before skill B is packaged at all.
   *
   * The consequence that would matter is order-dependent **bundling**, not just
   * stamping. `processLink` in `walk-link-graph.ts` reads
   * `link.resolvedId ? getResourceById(...) : getResource(targetPath)`, so an
   * asset skill A registered takes the registry-resource branch for skill B
   * rather than the bundled-asset branch: a different collection
   * (`bundledResourceMap` → `bundledResources` → `outputResources`, instead of
   * `bundledAssetSet` → `bundledAssets`), a different `maxBundledDepth`
   * contribution, and `recordUnfollowedLinks` running over it. Note the
   * `resolvedId` stamp is not the only lever — the `getResource(targetPath)`
   * fallback finds the shared registration on its own. The *shared registry* is
   * the mechanism; this method is one of its two writers.
   *
   * Nothing downstream absorbs it, either: `outputResources` in
   * `skill-packager.ts` is a **shallow** spread (`{...resource, filePath}`), so
   * `links` is the same array object as the source registry's. There is no
   * two-registry isolation — it is one mutable object graph with two path views.
   *
   * ⚠️ **Status, which is as load-bearing as the hazard: shape confirmed,
   * consequence NOT reproduced.** An independent fact-check of the design
   * review that raised it produced **zero** reproductions. The
   * global-mutation shape above is verified by reading the code; the
   * order-dependent bundling consequence is *not* demonstrated by a running case
   * and must not be called a shipped bug until one exists. Both halves are
   * recorded on purpose: without the hazard the next reader deletes this caution
   * as unmotivated, without the status they repeat a claim they cannot show.
   *
   * One leg of the original hazard has since closed. It cited "assets bypass
   * depth limits, registry resources do not" — but `processRegistryResource`
   * (`walk-link-graph.ts`) now tests `isRoutable` BEFORE
   * `maxDepth`, so a non-routable registry member — and a `.yaml` asset is
   * exactly that — is treated as a leaf and bypasses the depth limit just as a
   * plain asset does. The divergence in *which collection it lands in* remains.
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
   * Get resources by content key.
   *
   * Returns all resources with identical bytes routed to the same parser (same
   * content key). The key includes the parse route, so two files with identical
   * bytes routed to different parsers (a `.md` and a `.html`) are not returned
   * together.
   *
   * @param contentKey - Content key to search for (`<parserKind>.<keyKind>.<hex>`); a group is one key kind
   * @returns Array of resources with that content key (empty if none found)
   *
   * @example
   * ```typescript
   * const resource = registry.getResource('./docs/README.md');
   * const duplicates = registry.getResourcesByContentKey(resource.contentKey);
   * if (duplicates.length > 1) {
   *   console.log('Found duplicate content in:');
   *   duplicates.forEach(r => console.log(`  ${r.filePath}`));
   * }
   * ```
   */
  getResourcesByContentKey(contentKey: ContentKey): ResourceMetadata[] {
    return this.resourcesByContentKey.get(contentKey) ?? [];
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
    this.resourcesByContentKey.clear();
    this.duplicateIdCollisions = [];
    this.unreadableResources = [];
    this.parseRefusedResources = [];
    this.populationConditions = [];
    // The resolver's conflict accumulator belongs to the files it typed; a fresh
    // crawl types afresh and must not re-report the previous population's.
    this.mimeResolverInstance = undefined;
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
   * Get groups of duplicate resources based on content key.
   *
   * Returns an array where each element is an array of resources
   * that have the same content key (identical bytes, same parse route).
   * Only groups with 2+ resources are included. Identical bytes routed to
   * different parsers are not duplicates: the key includes the parse route. A group is one key kind: two key kinds of one byte string are not comparable and never grouped.
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
    for (const group of this.resourcesByContentKey.values()) {
      if (group.length >= 2) {
        duplicateGroups.push(group);
      }
    }
    return duplicateGroups;
  }

  /**
   * Get one representative resource for each unique content key.
   *
   * When multiple resources have the same content key, only the first
   * one encountered is included in the result. Identical bytes routed to
   * different parsers have different keys, so each is kept.
   *
   * @returns Array of unique resources (one per content key)
   *
   * @example
   * ```typescript
   * const unique = registry.getUniqueByContentKey();
   * console.log(`${unique.length} unique resources by content`);
   * ```
   */
  getUniqueByContentKey(): ResourceMetadata[] {
    const unique: ResourceMetadata[] = [];
    for (const group of this.resourcesByContentKey.values()) {
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
   * - byContentKey: Multiple resources per content key (Map<ContentKey, Array>)
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

    // Index by content key (1:many)
    const contentKeyArray = this.resourcesByContentKey.get(resource.contentKey);
    if (contentKeyArray) {
      contentKeyArray.push(resource);
    } else {
      this.resourcesByContentKey.set(resource.contentKey, [resource]);
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

/**
 * One population-time condition as the finding `validate()` emits for it.
 *
 * Built by hand rather than through `createRegistryIssue` because a row's code
 * is an open vocabulary: the catalogue entry, when there is one, supplies the
 * remedy and the reference, and the row supplies everything else. Severity is
 * the ROW's — the framework's `finalize` then applies the adopter's override
 * for a catalogued code and leaves an uncatalogued one exactly as stated.
 *
 * @param row - The condition, or the registry's own equivalent of one
 * @returns The issue, located at the row's root-relative path
 */
function populationConditionIssue(
  row: Pick<RealizationConditionRow, 'code' | 'severity' | 'message' | 'path'>,
): ValidationIssue {
  const entry = (CODE_REGISTRY as Partial<Record<string, (typeof CODE_REGISTRY)[IssueCode]>>)[row.code];
  return {
    code: row.code as ValidationIssueCode,
    severity: row.severity,
    message: row.message,
    location: row.path,
    ...(entry === undefined ? {} : { fix: entry.fix, reference: entry.reference }),
  };
}

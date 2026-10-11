/**
 * Resources validate command - strict validation with error reporting
 *
 * Publishes the `Report<T>` envelope (`validate-schema.ts`): every finding flat
 * with its `location` relative to `data.root`, `examined` = resources validated.
 * A run over zero resources is refused by the writer, from the registry's
 * declared denominator — never by a check at this site.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { conventionalSuiteProbe, packagedFileEntries } from '@vibe-agent-toolkit/agent-skills';
import {
  DeferredArtifacts,
  matchesCollection,
  type CollectionConfig,
  type CollectionStats,
  type DeferredSkillFiles,
  type ProjectConfig,
} from '@vibe-agent-toolkit/resources';
import {
  buildReport,
  countBySeverity,
  resultStatus,
  toFindings,
  type Finding,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { ASSET_REFERENCE_UNRESOLVED_CODE, isVatError, resolveAssetReference, safePath } from '@vibe-agent-toolkit/utils';
import type { GitTracker } from '@vibe-agent-toolkit/utils/git';
import * as yaml from 'yaml';

import type { DocumentFormat } from '../../report-schemas.js';
import { CommandRefusalError, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithReport, NOTHING_FINISHED, publishedReport, refusalReport } from '../../utils/document-writer.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { classifyInputFault, projectRootOrLoudCwd } from '../../utils/project-root-policy.js';
import { assertDeclaredCollection, loadResourcesWithConfig } from '../../utils/resource-loader.js';
import { warnRunIntegrity } from '../../utils/run-integrity.js';
import { collectDeclaredEvalSuites, mergeSkillPackagingConfig } from '../../utils/skill-packaging-config.js';
import type { PhaseOutcome } from '../phase-utils.js';
import { discoverSkillsFromConfig } from '../skills/skill-discovery.js';

import type { ResourcesValidateData, ResourcesValidateReport } from './validate-schema.js';

/** The verb, as registered. */
const VERB = 'resources validate';

/** `vat resources validate` offers no `--strict`: warnings never fail it. */
const GATE = { strict: false } as const;

/** The refusal for a `--frontmatter-schema` read the OS refused: a fault on the argument, absent said in its own words. */
function unreadableSchema(resolvedPath: string, error: unknown): unknown {
  return classifyInputFault(resolvedPath, error, { origin: 'argument', message: `--frontmatter-schema names no file: ${resolvedPath}` });
}

/**
 * Read the `--frontmatter-schema` file the operator named.
 *
 * Each way it can fail is a refusal by code, decided HERE — the one site that
 * knows the file is the operator's input: an unsupported extension, an
 * absent file or a bare specifier that resolves to nothing → `USAGE_INVALID`
 * (the flag names nothing usable), a read the OS
 * refuses → `INPUT_UNREADABLE`, and content that is not a JSON/YAML object →
 * `INPUT_UNREADABLE` (not the kind of thing the flag takes).
 */
async function loadSchema(schemaPath: string): Promise<object> {
  let resolvedPath: string;
  try {
    resolvedPath = resolveAssetReference(schemaPath, process.cwd());
  } catch (error) {
    if (!isVatError(error, ASSET_REFERENCE_UNRESOLVED_CODE)) throw error;
    throw new CommandRefusalError('USAGE_INVALID', `--frontmatter-schema names no file: ${error.message}`, { cause: error });
  }
  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext !== '.json' && ext !== '.yaml' && ext !== '.yml') {
    throw new CommandRefusalError('USAGE_INVALID', `Unsupported schema format: ${ext} (use .json or .yaml): ${schemaPath}`);
  }

  let content: string;
  try {
    content = await readFile(resolvedPath, 'utf-8');
  } catch (error) {
    throw unreadableSchema(resolvedPath, error);
  }

  let parsed: unknown;
  try {
    parsed = ext === '.json' ? JSON.parse(content) : yaml.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CommandRefusalError('INPUT_UNREADABLE', `--frontmatter-schema ${resolvedPath} does not parse: ${detail}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CommandRefusalError('INPUT_UNREADABLE', `--frontmatter-schema ${resolvedPath} must hold a schema object`);
  }
  return parsed;
}

/**
 * Log git tracker stats if available.
 */
function logGitTrackerStats(gitTracker: GitTracker | undefined, logger: Logger): void {
  if (gitTracker) {
    const gitStats = gitTracker.getStats();
    logger.debug(`Git tracker cache size: ${gitStats.cacheSize} files`);
  }
}

/** One resource this run validated: its absolute path and the collections it belongs to. */
export interface ValidatedResource {
  readonly filePath: string;
  readonly collections?: readonly string[] | undefined;
}

/** What {@link buildResourcesValidateReport} needs — the run's results, nothing it has to go and read. */
export interface ResourcesValidateInput {
  /** The project root: the ONE base every `location` and `path` is relative to. */
  readonly root: string;
  /** The resources in scope (the `--collection` ones when filtered) — `examined` is their count. */
  readonly resources: readonly ValidatedResource[];
  /** The library's severity-resolved issues over those resources; `ignore` is dropped here. */
  readonly issues: readonly ValidationIssue[];
  /** The configured collections, narrowed to the `--collection` one when filtered. */
  readonly collectionStats: CollectionStats | undefined;
  /** `--verbose`: publish one `data.files` row per resource validated. */
  readonly verbose: boolean;
  readonly durationMs: number;
}

/** A validated resource, with its path relative to the stated root. */
type LocatedResource = ValidatedResource & { readonly relativePath: string };

/** The findings located at each root-relative path. */
function findingsByLocation(findings: readonly Finding[]): Map<string, Finding[]> {
  const byLocation = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (finding.location === undefined) continue;
    const located = byLocation.get(finding.location) ?? [];
    located.push(finding);
    byLocation.set(finding.location, located);
  }
  return byLocation;
}

/** Each configured collection, with the findings located in its files counted. */
function collectionsData(
  collectionStats: CollectionStats | undefined,
  resources: readonly LocatedResource[],
  byLocation: ReadonlyMap<string, readonly Finding[]>,
): ResourcesValidateData['collections'] {
  const collections: ResourcesValidateData['collections'] = {};
  for (const [id, stat] of Object.entries(collectionStats?.collections ?? {})) {
    const perFile = resources
      .filter((resource) => resource.collections?.includes(id) ?? false)
      .map((resource) => byLocation.get(resource.relativePath) ?? []);
    collections[id] = {
      ...stat,
      filesWithErrors: perFile.filter((findings) => findings.some((finding) => finding.severity === 'error')).length,
      summary: countBySeverity(perFile.flat()),
    };
  }
  return collections;
}

/**
 * Build the report. Pure: no file system, no clock, no `process.exit`.
 *
 * `status` and `summary` are derived by `buildReport` from the findings, so an
 * info-only run is `findings` with `summary.info` naming what was found — one
 * vocabulary with every other report verb. The run-integrity refusal for a run
 * over zero resources is NOT decided here; the writer adds it from the
 * registry's declared denominator.
 *
 * @param input - The run's results
 * @returns The report, before the writer's run-integrity pass
 */
export function buildResourcesValidateReport(input: ResourcesValidateInput): ResourcesValidateReport {
  const findings = toFindings(input.issues);
  const byLocation = findingsByLocation(findings);
  const resources: LocatedResource[] = input.resources.map((resource) => ({
    ...resource,
    relativePath: safePath.relative(input.root, resource.filePath),
  }));

  const data: ResourcesValidateData = {
    // Stated once, and the only absolute path in the document.
    root: input.root,
    collections: collectionsData(input.collectionStats, resources, byLocation),
  };
  if (input.verbose) {
    data.files = resources.map((resource) => {
      const located = byLocation.get(resource.relativePath) ?? [];
      return { path: resource.relativePath, status: resultStatus(located), summary: countBySeverity(located) };
    });
  }

  return buildReport({ examined: resources.length, findings, data, gate: GATE, durationMs: input.durationMs });
}

export interface ValidateOptions {
  debug?: boolean;
  /** Show all scanned resources, including those without issues (per-issue detail). */
  verbose?: boolean;
  frontmatterSchema?: string; // Path to JSON Schema file
  validationMode?: 'strict' | 'permissive'; // Validation mode for schemas
  format?: DocumentFormat; // Output format: yaml (default), json or text
  collection?: string; // Filter by collection ID
  checkExternalUrls?: boolean; // NEW: Validate external URLs
  checkHtmlAnchors?: boolean; // Strictly validate HTML fragment anchors against element ids
  cache?: boolean; // Commander negates this when --no-cache is passed; absent = true (cache enabled)
  checkFrontmatterLinks?: boolean; // Commander negates this when --no-check-frontmatter-links is passed; absent = true
}

/**
 * Translate `--no-cache` into the `noCache` input `ResourceRegistry.validate()`
 * takes.
 *
 * Commander represents a `--no-x` boolean as the POSITIVE key `x` — defaulted to
 * `true`, set to `false` only when the negated flag is passed. It never emits a
 * `noX` key. This site used to read `options.noCache`, typed against an
 * interface that itself declared `noCache?: boolean`, so the compiler validated
 * a read of a key Commander cannot produce: `--no-cache` was a silent no-op and
 * the external-URL cache was never disabled. Declaring the key Commander really
 * emits is what makes the type an ally here rather than an accomplice.
 */
export function resolveNoCache(options: Pick<ValidateOptions, 'cache'>): boolean {
  return options.cache === false;
}

/**
 * Apply the --no-check-frontmatter-links CLI flag to the loaded config.
 *
 * Mutates the config object in place (the registry holds a reference to the
 * same object, so validate() will see the updated value).
 */
function applyNoCheckFrontmatterLinksFlag(config: ProjectConfig | undefined): void {
  if (!config?.resources?.collections) return;
  for (const collection of Object.values(config.resources.collections)) {
    if (collection.validation) {
      collection.validation.checkFrontmatterLinks = false;
    }
  }
}

/**
 * Compute the project's `DeferredArtifacts` model for `vat resources validate`,
 * reusing the SAME skill discovery (`discoverSkillsFromConfig`), config merge
 * (`mergeSkillPackagingConfig`) and test-input filter (`packagedFileEntries`) that
 * the skills lanes use — so no two lanes can disagree about a skill's effective
 * `files:` config, or about which of those entries the build will actually copy,
 * for the same link. Exported (rather than inlined in `validateCommand`) so any
 * other lane that needs the project's deferred model shares this derivation
 * instead of re-deriving it.
 *
 * Returns undefined when the project declares no skills at all, or when no skill
 * declares a `files:` mapping — in either case there is nothing to defer, so
 * callers should omit `deferredArtifacts` entirely rather than pass around an
 * empty model. The `files:` short-circuit also keeps skill discovery (a read and
 * a frontmatter parse per declared skill) off `vat resources validate` for the
 * majority of projects, which declare no `files:` at all.
 */
export async function computeDeferredArtifacts(
  config: ProjectConfig | undefined,
  projectRoot: string,
): Promise<DeferredArtifacts | undefined> {
  if (!config?.skills) {
    return undefined;
  }
  const declaresFiles =
    config.skills.defaults?.files !== undefined ||
    Object.values(config.skills.config ?? {}).some((skill) => skill?.files !== undefined);
  if (!declaresFiles) {
    return undefined;
  }

  // `'refuse'`: the `files:` dest check below is only as complete as this
  // list. The throw lands in the command's catch → a refusal by its code, exit 2.
  const discovered = await discoverSkillsFromConfig(config.skills, projectRoot, 'refuse');
  const { defaults, config: perSkillConfig } = config.skills;

  // Assembled ONCE for the whole run, then handed to every skill below. Rebuilding
  // it inside the map would walk the project's entire skills config per skill.
  const projectSkills = collectDeclaredEvalSuites(config.skills, discovered);

  // Assembled ONCE for the same reason, and it is the more expensive of the two.
  // `packagedFileEntries` probes the filesystem for a conventional eval suite under
  // the subject AND under every entry of `projectSkills`, so a probe built inside
  // the map costs O(S) per skill and O(S²) per run. Measured on a 103-skill adopter
  // before this hoist: 10,815 `existsSync` calls over 103 distinct paths — ~105× each,
  // and EXACTLY HALF of every filesystem call `vat resources validate` made.
  //
  // Run-scoped rather than module-scoped, deliberately: the probe's answer is a
  // snapshot of the filesystem, so a cache outliving the run would keep answering
  // for a tree that has since changed. One run already answers every skill from one
  // `projectSkills` snapshot, so holding it for the run's width is consistent.
  const suiteProbe = conventionalSuiteProbe();

  const skillFiles: DeferredSkillFiles[] = discovered.map((skill) => {
    const merged = mergeSkillPackagingConfig(
      defaults as Record<string, unknown> | undefined,
      perSkillConfig?.[skill.name] as Record<string, unknown> | undefined,
    );
    const skillDir = path.dirname(skill.sourcePath);
    return {
      // Only what the packager will really copy — an entry pointing into ANY
      // skill's declared test input (its own or a sibling's) is dropped at build
      // time, so its dest cannot defer a link here without contradicting the build.
      files: packagedFileEntries(merged, skillDir, projectRoot, projectSkills, suiteProbe),
      skillDir,
    };
  });

  return DeferredArtifacts.from(skillFiles, projectRoot);
}


/**
 * Validate resources and build the report, printing nothing.
 *
 * @throws Whatever refuses the run — a refusal by its code (`refusalCodeOf`)
 */
async function runValidation(
  pathArg: string | undefined,
  options: ValidateOptions,
  logger: Logger,
  startTime: number,
): Promise<ResourcesValidateReport> {
  // Resolve projectRoot at the CLI boundary (spec §5/§7 — loud-cwd policy).
  const projectRoot = projectRootOrLoudCwd(pathArg ?? process.cwd(), logger);

  // Load resources with config support (includes GitTracker initialization)
  const { registry, config, gitTracker } = await loadResourcesWithConfig(pathArg, projectRoot, logger);
  assertDeclaredCollection(config, options.collection);

  // CLI flag: --no-check-frontmatter-links disables the check for every collection.
  // Commander represents the negated form as options.checkFrontmatterLinks === false.
  if (options.checkFrontmatterLinks === false) {
    applyNoCheckFrontmatterLinksFlag(config);
  }

  let frontmatterSchemaObj: object | undefined;
  if (options.frontmatterSchema) {
    logger.debug(`Loading frontmatter schema from: ${options.frontmatterSchema}`);
    frontmatterSchemaObj = await loadSchema(options.frontmatterSchema);
  }

  // Compute deferred build-artifact coverage from the SAME skill discovery +
  // config-merge `vat skills validate` uses, so a `files:`-declared link that
  // lane reports as LINK_DEFERRED_ARTIFACT (info) is never independently
  // reported here as LINK_BROKEN_FILE (error) — the headline bug this closes.
  const deferredArtifacts = await computeDeferredArtifacts(config, projectRoot);

  const validationResult = await registry.validate({
    ...(frontmatterSchemaObj ? { frontmatterSchema: frontmatterSchemaObj } : {}),
    validationMode: options.validationMode ?? 'strict',
    checkExternalUrls: options.checkExternalUrls ?? false,
    checkHtmlAnchors: options.checkHtmlAnchors ?? false,
    noCache: resolveNoCache(options),
    // Thread the project's resources.validation config in. The CLI does NOT
    // resolve severity itself — ResourceRegistry.validate() runs the framework.
    validationConfig: config?.resources?.validation ?? {},
    ...(deferredArtifacts !== undefined && { deferredArtifacts }),
  });
  logGitTrackerStats(gitTracker, logger);

  // 🔑 `--collection` scopes the WHOLE report — findings, `examined`, and so
  // the exit code — to that collection's resources. The exit code derives from
  // the published document alone, so a report and its exit code never disagree.
  const resources = registry.getAllResources()
    .filter((resource) => options.collection === undefined || (resource.collections?.includes(options.collection) ?? false));
  // `ValidationResult` is Zod-inferred and widens `code` to string; the issues
  // themselves are the `ValidationIssue`s every producer built.
  const issues = inCollectionScope(validationResult.issues as ValidationIssue[], {
    projectRoot,
    all: registry.getAllResources(),
    inScope: resources,
    collection: options.collection === undefined ? undefined : config?.resources?.collections?.[options.collection],
  });

  return buildResourcesValidateReport({
    root: projectRoot,
    resources,
    issues,
    collectionStats: narrowCollectionStats(registry.getCollectionStats(), options.collection),
    verbose: options.verbose === true,
    durationMs: Date.now() - startTime,
  });
}

/**
 * The findings `--collection` keeps: those about the named collection, and
 * those about the run.
 *
 * - A finding with no location is about the run: kept.
 * - One located at a RESOURCE is kept when that resource is in the collection.
 * - One located at a path that never became a resource (a file the glob
 *   matched and could not read, a MIME conflict) is kept when the collection's
 *   OWN include/exclude patterns match that path — the same `matchesCollection`
 *   the registry assigns membership with.
 *
 * 🚨 Keeping only "findings at the collection's resources" published `ok`, exit
 * 0, over an unreadable file in the collection; keeping every non-resource
 * path failed `--collection X` on collection Y's unreadable file.
 *
 * @param issues - The library's issues over the whole run
 * @param scope - The root, every resource, the collection's resources, and its config
 * @returns The issues in scope — all of them when no collection is named
 */
function inCollectionScope(
  issues: readonly ValidationIssue[],
  scope: {
    projectRoot: string;
    all: readonly { filePath: string }[];
    inScope: readonly { filePath: string }[];
    collection: CollectionConfig | undefined;
  },
): ValidationIssue[] {
  const { collection, projectRoot } = scope;
  if (collection === undefined) return [...issues];
  const relative = (resource: { filePath: string }): string => safePath.relative(projectRoot, resource.filePath);
  const resourcePaths = new Set(scope.all.map(relative));
  const inScope = new Set(scope.inScope.map(relative));
  return issues.filter((issue) => {
    if (issue.location === undefined) return true;
    if (resourcePaths.has(issue.location)) return inScope.has(issue.location);
    return matchesCollection(safePath.resolve(projectRoot, issue.location), collection);
  });
}

/**
 * Validate resources and hand back the report, printing it nowhere.
 *
 * The phase entry point for `vat validate` and `vat verify`, and the command's
 * own. The report is the one BEFORE the writer's run-integrity pass: inside an
 * orchestrator, zero examined is judged on the whole run, not on this phase. A
 * refusal is the envelope's error branch, its message already on stderr, and a
 * site-specific run-integrity finding is warned here, where both lanes see it.
 */
export async function runResourcesValidatePhase(
  pathArg: string | undefined,
  options: ValidateOptions
): Promise<PhaseOutcome> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const report = await runValidation(pathArg, options, logger, startTime);
    warnRunIntegrity(report);
    return { report };
  } catch (error) {
    return { report: refusalReport(refusalCodeOf(error), error, GATE, NOTHING_FINISHED) };
  }
}

export async function validateCommand(
  pathArg: string | undefined,
  options: ValidateOptions
): Promise<void> {
  const { report } = await runResourcesValidatePhase(pathArg, options);
  const published = publishedReport(VERB, report);
  // The writer's own zero-examined refusal, warned in the lane that publishes it.
  if (published !== report) warnRunIntegrity(published);
  endWithReport('resources validate', published, options.format ?? 'yaml');
}

/**
 * Narrow collection stats to the one requested collection — or to none when it
 * holds no resource (the registry's stats list only collections with members;
 * an undeclared name was refused before this runs).
 */
function narrowCollectionStats(
  collectionStats: CollectionStats | undefined,
  collection: string | undefined
): CollectionStats | undefined {
  if (!collection || !collectionStats) {
    return collectionStats;
  }
  const collectionStat = collectionStats.collections[collection];
  if (!collectionStat) {
    return undefined;
  }
  return {
    totalCollections: 1,
    resourcesInCollections: collectionStat.resourceCount,
    collections: { [collection]: collectionStat },
  };
}

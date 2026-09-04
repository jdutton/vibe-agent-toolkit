/**
 * Enhanced skill validation for packaging
 *
 * Extends basic skill validation with:
 * - Size/complexity validation (SKILL.md lines, total lines, file count)
 * - Link depth analysis (prevent deep nesting)
 * - Navigation file detection (README.md, index.md patterns)
 * - Framework-based severity / allow config (validation.severity, validation.allow)
 *
 * Used by:
 * - vat skills validate (report errors, exit 1 on failure)
 * - vat skills build (block build on validation errors)
 * - vat skills audit --user (report issues, exit 0 always)
 */

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { DeferredArtifacts, loadConfig, parseFileCached, ResourceRegistry, type ResourcePopulationSource, type SkillExecutableEntry } from '@vibe-agent-toolkit/resources';
import {
  CODE_REGISTRY,
  runSingleUnitValidation,
  runValidationFramework,
  type AllowUsageLedger,
  type AllowRecord,
  type IssueCode,
  type ValidationConfig,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import {
  findProjectRoot,
  issueLocation,
  normalizedTmpdir,
  toForwardSlash,
  safePath,
} from '@vibe-agent-toolkit/utils';
import { type GitTracker } from '@vibe-agent-toolkit/utils/git';

import type { EvidenceRecord, Observation } from '../evidence/index.js';
import { collectPreBuildGlobFindings, preBuildGlobFindingsToIssues } from '../files-config.js';
import {
  conventionalSuiteProbe,
  partitionTestInputFileEntries,
  resolveTestInputDirs,
  testInputExcludeRules,
  testInputLinkIssues,
  type ConventionalSuiteProbe,
  type DeclaredEvalSuite,
} from '../test-input.js';
import { walkLinkGraph, type LinkResolution, type WalkableRegistry } from '../walk-link-graph.js';

import { observationToIssue, runCompatDetectors } from './compat-detectors.js';
import { detectUndeclaredCrossSkillAuth } from './cross-skill-dependency-detection.js';
import { validateFrontmatterRules, validateFrontmatterSchema } from './frontmatter-validation.js';
import { materializeIssue } from './rule-engine/index.js';
import { SOURCE_ONLY_CODES } from './source-only-codes.js';
import {
  VALIDATION_RULES,
  VALIDATION_THRESHOLDS,
} from './validation-rules.js';
import { deferredAssetsToIssues, walkerExclusionsToIssues } from './walker-to-issues.js';

/** Exclude reason constants to avoid duplicate string literals */
const EXCLUDE_REASON_DIRECTORY = 'directory-target' as const;
const EXCLUDE_REASON_OUTSIDE_PROJECT = 'outside-project' as const;
const DETAIL_REASON_DEPTH: ExcludedReferenceDetail['reason'] = 'depth-exceeded';

/**
 * Packaging configuration for skill validation.
 * Replaces the old VatSkillMetadata parameter — accepts packaging options directly.
 */
export interface SkillPackagingConfig {
  linkFollowDepth?: number | 'full';
  resourceNaming?: 'basename' | 'resource-id' | 'preserve-path';
  stripPrefix?: string;
  excludeNavigationFiles?: boolean;
  excludeReferencesFromBundle?: {
    rules?: Array<{ patterns: string[]; template?: string }>;
    defaultTemplate?: string;
  };
  files?: Array<{ source: string; dest: string }>;
  /** Framework-based validation configuration (severity overrides and allow entries). */
  validation?: ValidationConfig | undefined;
  /**
   * Declared runtime targets for this skill. Used by the CLI verdict layer
   * to suppress non-applicable compat verdicts. The packaging validator
   * itself only stores the declaration; verdict computation lives in the
   * CLI (which can also bring in plugin / marketplace target layers).
   */
  targets?: ReadonlyArray<'claude-chat' | 'claude-cowork' | 'claude-code'>;
  /**
   * Declared executables the skill ships (name-stable references for eval
   * `toolExpectations` + launch-guidance linting — issue #145 Phase T/L). The
   * config merge (`mergeSkillPackagingConfig`) copies this through generically;
   * declaring it here lets consumers (e.g. `vat skill test run`) read it typed.
   */
  executables?: SkillExecutableEntry[];
  /**
   * The skill's `vat skill test` config. Only `evals` is load-bearing for packaging:
   * it declares where the skill's TEST INPUT lives, which packaging must exclude
   * from the shipped bundle (see test-input.ts). The rest of the block is carried
   * through generically by the config merge and read by `vat skill test`.
   */
  test?: { evals?: string | undefined } | undefined;
}

/** Excluded reference detail for verbose output */
export interface ExcludedReferenceDetail {
  path: string;
  reason: 'depth-exceeded' | 'pattern-matched' | 'outside-project' | 'navigation-file' | 'agent-instruction-file' | 'skill-definition' | 'gitignored' | 'non-routable-source';
  matchedPattern?: string | undefined;
}

/**
 * Enhanced validation result using the unified framework
 */
export interface PackagingValidationResult {
  /** Skill name */
  skillName: string;

  /**
   * Gate verdict: `error` iff there is an active error. TWO-valued on purpose —
   * this is the build/validate gate, and a warning does not fail a build.
   *
   * It therefore says NOTHING about warnings or info. Read {@link
   * PackagingValidationResult.allErrors} for the distribution — via
   * `countBySeverity(result.allErrors)` from `@vibe-agent-toolkit/schema`,
   * which is the same collapse every other lane uses.
   */
  status: 'success' | 'error';

  /**
   * THE container: every emitted issue after severity resolution, stored once.
   *
   * This includes `info`, despite the name: severity resolution keeps info
   * issues in the framework's `emitted` set. Issues suppressed by `allow` are
   * NOT here — they live in {@link PackagingValidationResult.ignoredErrors}.
   *
   * There are deliberately no `activeErrors` / `activeWarnings` sibling arrays.
   * They were filtered views over this same array, and because every consumer
   * that serializes a result spreads the whole object, each issue record —
   * including its paragraph-length `fix` and `reference` prose — was written to
   * the output document twice. Derive the partition instead:
   * {@link activeErrorsOf} / {@link activeWarningsOf}, or `countBySeverity` /
   * `calculateValidationStatus` from `@vibe-agent-toolkit/schema`.
   */
  allErrors: ValidationIssue[];

  /** Issues suppressed by allow entries */
  ignoredErrors: AllowRecord[];

  /**
   * Capability observations rolled up from compat detectors.
   * Carried alongside emitted issues so downstream verdict computation
   * (CLI layer) can recover observation payloads (e.g. EXTERNAL_CLI binary)
   * without re-parsing the skill.
   */
  observations: Observation[];

  /**
   * Raw evidence records collected by compat detectors. Surfaced so that
   * audit `--verbose` can render the underlying matches for each capability
   * observation without re-parsing the skill.
   */
  evidence: EvidenceRecord[];

  /** Metadata about the skill */
  metadata: {
    skillLines: number;
    totalLines: number;
    fileCount: number;
    directFileCount: number;
    maxLinkDepth: number;
    excludedReferenceCount: number;
    excludedReferences: ExcludedReferenceDetail[];
  };
}

/** Anything carrying the emitted-issue container — a result, or a partial of one. */
type WithAllErrors = Pick<PackagingValidationResult, 'allErrors'>;

/**
 * The active errors: emitted, resolved-severity `error`.
 *
 * Derived on read, never stored on the result — see the `allErrors` doc comment
 * for why. Equivalent to `result.status === 'error'` when all you need is the
 * gate bit; use this only when you need the issues themselves.
 */
export function activeErrorsOf(result: WithAllErrors): ValidationIssue[] {
  return result.allErrors.filter(i => i.severity === 'error');
}

/** The active warnings: emitted, resolved-severity `warning`. Derived on read. */
export function activeWarningsOf(result: WithAllErrors): ValidationIssue[] {
  return result.allErrors.filter(i => i.severity === 'warning');
}

/**
 * Validate files config entries for duplicate dest values and directory sources.
 *
 * A `files:` entry is a typed single-file slot: its source must resolve to a
 * file, not a directory. If the source path exists and is a directory, emit
 * LINK_TARGETS_DIRECTORY. Missing sources are not flagged here (deferred build
 * artifacts are handled by the skill-packager).
 */
function validateFilesConfig(
  files: Array<{ source: string; dest: string }> | undefined,
  projectRoot: string,
  locationRoot: string,
): ValidationIssue[] {
  if (!files?.length) return [];

  const issues: ValidationIssue[] = [];
  const destSet = new Set<string>();

  for (const entry of files) {
    const normalized = toForwardSlash(entry.dest);
    if (destSet.has(normalized)) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_FILES_DEST',
        message: `Duplicate dest '${entry.dest}' in files config. Each dest must be unique.`,
      });
    }
    destSet.add(normalized);

    // Check if an existing source resolves to a directory — a typed single-file
    // slot cannot be satisfied by a directory.
    const resolvedSource = safePath.resolve(safePath.join(projectRoot, entry.source));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolvedSource derived from config-supplied path
    if (existsSync(resolvedSource) && statSync(resolvedSource).isDirectory()) {
      // Anchor at the resolved source, expressed in the run's ONE coordinate
      // system — not the raw config value, which is project-relative and so
      // unresolvable in a run that spans several projects.
      const location = issueLocation(resolvedSource, locationRoot);
      issues.push(registryIssueAt(
        'LINK_TARGETS_DIRECTORY',
        `files: source '${entry.source}' resolves to a directory; a typed single-file slot requires a file`,
        location,
      ));
    }
  }

  return issues;
}

/**
 * Create a validation issue from a code-registry code with a bespoke message,
 * anchored at a project-relative `location`.
 *
 * Thin wrapper over the shared {@link materializeIssue} so severity / fix /
 * reference come from the single CODE_REGISTRY source (issue #129 dedup); the
 * caller supplies a fully-formed `message`.
 *
 * Deliberately NOT named `createRegistryIssue`: `@vibe-agent-toolkit/schema`
 * exports a function by that name whose third parameter is an EXTRAS OBJECT, not
 * a location string. Two same-named functions with incompatible third arguments
 * is a trap for anyone reading a call site.
 */
function registryIssueAt(
  code: IssueCode,
  message: string,
  location?: string,
): ValidationIssue {
  return materializeIssue(code, { message, location });
}

/**
 * Options for {@link crawlAndResolveRegistry}.
 */
export interface CrawlRegistryOptions {
  /**
   * Where the file list comes from — omit for the incumbent walk, supply one to
   * source it from a projection instead.
   *
   * Also part of the memo key, by identity: see {@link sourcedRegistryCache}.
   *
   * Selecting the lane stays the CLI's job. This signature takes a source, never
   * an environment, so a library caller that passes nothing keeps the walk.
   */
  populationSource?: ResourcePopulationSource | undefined;
}

/**
 * Build a fresh ResourceRegistry for a single skill's projectRoot and resolve
 * internal links. Extracted so the skill validator can fall back to a private
 * registry when the caller does not supply a shared one.
 *
 * Crawls markdown AND HTML (`.html`/`.htm`) so the live audit/validate path
 * sees the same link graph the built path does (issue #129 AC2). The registry
 * parses HTML via parse5 and surfaces its `local_file` links, so the walker
 * traverses HTML references and catches HTML broken links at source time — not
 * just at build time. (Previously the crawl was markdown-only, so source HTML
 * was invisible to audit/validate.)
 *
 * Exported so external callers (e.g. the inventory layer) can build a registry
 * once and pass it down rather than re-crawling per skill.
 *
 * ## Why the config is READ here rather than threaded in
 *
 * A collection may declare a `mimeType` that overrides `mime-type.ts`'s
 * extension tables and so decides which parser runs; `ResourceRegistry` honours
 * those declarations only when it was handed a config, and the projection lane
 * behind `populationSource` reads them off the root. A config-less registry
 * therefore disagrees with the population that enumerated it about whether a
 * file is prose, inside a single command.
 *
 * Threading was considered and does not fit this function. Its callers discover
 * `projectRoot` **per skill** (`findProjectRoot` from each SKILL.md's directory,
 * and one `vat audit --user` run reached at least 72 distinct roots), so no
 * caller holds one config that governs them all. Worse, the memo below is keyed
 * on the root ALONE: an optional config argument would let two callers of one
 * root disagree and silently share whichever registry was built first.
 *
 * Reading it here is what `createProjectRegistry` in `skill-packager.ts` already
 * does, with the same `loadConfig`, for the same stated reason — "a registry
 * built without config silently belongs to no collection, so a lane that built
 * its own config-less registry rewrote frontmatter differently from the lane
 * that used this one". One read per root per process, behind the memo, against a
 * crawl that parses every document under it.
 *
 * ## A broken config falls back here, and is reported by the caller
 *
 * Unlike `createProjectRegistry`, this must NOT throw on a config that exists
 * and will not parse. Its principal caller is `vat audit`, whose pinned
 * behaviour is "tolerates, falls back to config-free validation" — a bulk linter
 * over trees VAT does not own must not be aborted by someone else's YAML
 * (`cli/test/integration/config-broken-behavior.integration.test.ts` is the map).
 *
 * The fallback is not the silent conflation that rule normally forbids, because
 * nothing is being hidden: `vat audit` reads the same config at its own layer,
 * catches `ConfigLoadError` there, and reports it. What this does is decline to
 * abort a scan from four frames down. A config that will not parse also gives
 * the projection lane no declarations, so the two lanes still AGREE — which is
 * the property this function exists to hold.
 */
export async function crawlAndResolveRegistry(
  projectRoot: string,
  options: CrawlRegistryOptions = {},
): Promise<ResourceRegistry> {
  const { populationSource } = options;
  const cache = registryCacheFor(populationSource);
  const key = toForwardSlash(safePath.resolve(projectRoot));
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  // The PROMISE is cached, not the resolved value, so two overlapping requests
  // for one root can never start two crawls.
  const pending = (async (): Promise<ResourceRegistry> => {
    const config = await loadConfig(projectRoot).catch(() => undefined);
    const registry = await ResourceRegistry.fromCrawl(
      {
        baseDir: projectRoot,
        include: ['**/*.md', '**/*.html', '**/*.htm'],
        // Enumeration only. `ResourceRegistry.crawl` re-applies the include set
        // above — and the crawl's default exclude — to whatever the source
        // offers, through the same compiled matcher the walk itself uses, so a
        // source that enumerates a whole tree still yields exactly this crawl's
        // markdown and HTML. Handing this builder a projection is a cost change,
        // not a scope change.
        ...(populationSource !== undefined && { populationSource }),
      },
      config === undefined ? undefined : { config },
    );
    registry.resolveLinks();
    return registry;
  })();
  cache.set(key, pending);
  return pending;
}

/**
 * Cache of (resolved project root → registry) for the INCUMBENT WALK, so the
 * crawl above is paid ONCE per root per process rather than once per skill.
 * Source-backed callers get {@link sourcedRegistryCache} instead, and the two
 * never meet — see there for why that separation is the whole point.
 *
 * It lives beside the crawl because every caller wants the same thing and the
 * cost is a property of the crawl, not of any one lane. `vat audit` had already
 * built this cache privately — and its own comment flagged the trap: the key
 * "must be the SAME value `validateSkillForPackaging` derives", or a mismatch
 * "silently degrades back to a per-skill crawl". Keying on the resolved path in
 * one place removes the duplicate and the trap. The lane that never had a cache —
 * the packager's post-build validation, called once per skill from both build
 * phases — gets the sharing without threading a registry through.
 *
 * Safe to hold for a process lifetime: every VAT entry point is a short-lived
 * CLI invocation. Note the crawl excludes build output (`BUILD_OUTPUT_GLOBS` via
 * the crawler's defaults), so packaging a skill mid-run cannot invalidate it.
 */
const walkRegistryCache = new Map<string, Promise<ResourceRegistry>>();

/**
 * The same memo for the SOURCE-BACKED lanes, keyed first by the population
 * source's IDENTITY and only then by root.
 *
 * ## Why the source is part of the key
 *
 * This crawl is memoized for a process and SHARED across commands that do not
 * know about each other: `vat skills build` reaches it per skill through
 * {@link validateSkillForPackaging}, `vat audit` reaches it directly, and the
 * pipeline oracles reach it as a lane. Keyed on the root ALONE, the FIRST
 * caller's population binds for the whole process, and a later caller asking a
 * different question transparently receives the earlier caller's answer — with
 * nothing in any output saying so. The projection lane does not merely enumerate
 * the same set faster: it sees uncommitted markdown, so it genuinely answers a
 * different membership question and ADDS `LINK_BROKEN_FILE` findings. Serving
 * one caller's answer to the other is a silent wrong answer in both directions.
 *
 * ## Why IDENTITY, and not a lane descriptor
 *
 * A `'walk' | 'projection'` tag would key two projection sources the same, and
 * two projection sources can differ in their ignore oracle (a run with no
 * `GitTracker` admits the ignored half of a tree), in which store answers them,
 * and in whether that store is still OPEN — `withResourcePopulationSource`
 * closes it when its bracket ends. A key that cannot see those differences is
 * the same bug one level down. The closure itself can never be wrong about
 * which of them it is.
 *
 * The win survives: one run holds ONE source closure for its whole bracket and
 * hands the same one to every skill, so a `vat skills build` still pays a single
 * crawl for the run rather than one per skill. Two independent callers cannot
 * hold the same closure by accident, so they cannot collide.
 *
 * A `WeakMap` rather than a `Map` because the entry's useful life is the
 * bracket's: once the source is unreachable its store is closed and its
 * registries can never be served again, so holding them would be a leak with no
 * upside. (`registryCacheFor` is what reads it; `resetPackagingRegistryCache`
 * replaces it wholesale, since a `WeakMap` cannot be cleared in place.)
 */
let sourcedRegistryCache = new WeakMap<
  ResourcePopulationSource,
  Map<string, Promise<ResourceRegistry>>
>();

/**
 * The (root → registry) memo this call belongs in: the walk's, or the one
 * private to this population source.
 *
 * Separate maps rather than a composite key, because the two are keyed on
 * different KINDS — a path string and an object identity — and a composite key
 * would have to stringify the source, which is exactly the information loss
 * {@link sourcedRegistryCache} exists to avoid.
 */
function registryCacheFor(
  populationSource: ResourcePopulationSource | undefined,
): Map<string, Promise<ResourceRegistry>> {
  if (populationSource === undefined) {
    return walkRegistryCache;
  }
  const existing = sourcedRegistryCache.get(populationSource);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, Promise<ResourceRegistry>>();
  sourcedRegistryCache.set(populationSource, created);
  return created;
}

/**
 * Drop every memoized registry.
 *
 * Required by any in-process caller that starts an INDEPENDENT run against a
 * tree it may have changed since the last one — the CLI entrypoint, and
 * integration tests sharing a vitest worker. Without it a second run reuses the
 * first run's parse of files that have since moved, and reports a stale answer
 * as a fresh one. `resetAuditCaches` calls this alongside its own caches.
 */
export function resetPackagingRegistryCache(): void {
  walkRegistryCache.clear();
  // Both lanes, or the reset is a half-truth: a caller that reset the cache and
  // then re-supplied the SAME source closure would be served the pre-reset parse
  // of a tree it may have changed. A `WeakMap` has no `clear`, so it is replaced.
  sourcedRegistryCache = new WeakMap();
}

/**
 * True iff the shared registry's baseDir is an ancestor of (or equals) the
 * skill's directory. Prevents the batched caller from reusing a registry that
 * was crawled for a different project root — the `getResource()` /
 * `getResourceById()` lookups would silently miss, and the walker would walk
 * an empty graph.
 */
function registryCoversSkill(registry: ResourceRegistry, skillPath: string): boolean {
  const baseDir = registry.baseDir;
  if (baseDir === undefined) return false;
  const normalizedBase = toForwardSlash(safePath.resolve(baseDir));
  const skillDir = toForwardSlash(safePath.resolve(dirname(skillPath)));
  if (skillDir === normalizedBase) return true;
  // eslint-disable-next-line local/no-path-startswith -- both sides normalized via toForwardSlash above
  return skillDir.startsWith(`${normalizedBase}/`);
}

/**
 * Shared context for batched skill validation runs.
 *
 * Populated once by the caller (e.g. `vat skills validate`) and threaded into
 * every per-skill validation so common setup is paid for exactly once:
 *   - `registry`: a pre-crawled + `.resolveLinks()`-completed ResourceRegistry
 *     covering the project root. Eliminates the per-skill markdown reparse.
 *   - `gitTracker`: a pre-populated {@link GitTracker} (from
 *     `GitTracker.initialize({ includeUntracked: true })`). Turns gitignore
 *     checks during the link-graph walk into O(1) set lookups instead of
 *     `git check-ignore` spawns.
 *
 * Both fields are optional — when omitted, the validator falls back to the
 * legacy per-skill behavior so one-off callers keep working.
 */
export interface SkillValidationSharedContext {
  /** Pre-built registry that covers the skill's project root. */
  registry?: ResourceRegistry;
  /**
   * Where the file list for the validator's OWN registry comes from, when it has
   * to build one (no `registry` above, or one that does not cover this skill).
   *
   * The lane seam for `vat skills build`, which — unlike `vat skills validate` —
   * supplies no shared registry and so reaches {@link crawlAndResolveRegistry}
   * per skill. Without this, a projection-lane build still enumerated that one
   * registry with the walk, which was the last packaging enumeration on it.
   *
   * Ignored when `registry` above already covers the skill: a caller that built
   * the registry itself has already chosen its lane, and re-deciding it here
   * would let one call carry two answers.
   *
   * Supply the SAME closure for every skill in a run (that is what
   * `withResourcePopulationSource` hands out), or the memo keys each call
   * separately and the run pays a crawl per skill.
   */
  populationSource?: ResourcePopulationSource;
  /** Pre-populated tracker for the repo that contains the skill. */
  gitTracker?: GitTracker;
  /**
   * Root every emitted `ValidationIssue.location` is expressed relative to.
   *
   * This is the ANCHOR base and it is a DIFFERENT concern from the project
   * root below: the project root is a validation-POLICY boundary (what counts
   * as "outside the project", where `files:` sources resolve from, what the
   * registry crawls), while the anchor base only answers "relative to what is
   * this location written?". Conflating the two is what let `vat audit` — which
   * spans many governing configs in a single run — emit one report in many
   * coordinate systems, with two distinct files sharing one `location`.
   *
   * A batching caller MUST pass its invocation scan root. Omitted, it falls
   * back to the project root, which is correct exactly when a run covers one
   * project (`vat skills validate`, `vat skills build`, `vat skill review`).
   */
  locationRoot?: string;
  /**
   * The RUN's allow-entry usage ledger.
   *
   * `validation.allow` is declared once per package but validated once per
   * skill, so "this entry matched nothing" is a question only the whole run can
   * answer — a batching caller MUST supply one ledger for the batch and drain it
   * with `allowUnusedIssues()` after the last skill. Without it, an entry scoped
   * to one skill's files is reported unused by every OTHER skill in the package
   * (measured: 78 ALLOW_UNUSED warnings from 3 legitimate entries).
   *
   * Omitting it is a positive claim that THIS call is the whole run — correct for
   * the single-skill callers (`vat skill review`, `vat audit`, whose shared
   * context is built per skill), where the per-skill and run-level answers
   * coincide. `vat skills build` supplies one: its pre-build source check is the
   * ONLY lane in that run that can match an entry scoped to a source filename
   * (packaging renames the file to `SKILL.md`), so withholding its matches
   * reported live entries as dead on every skill in the package.
   *
   * KNOWN GAP, worth fixing if you are already in this area: the plugin-local
   * skill loop in `packages/cli/src/commands/claude/plugin/build.ts` still omits
   * a ledger while looping, so it makes that positive claim falsely. It measures
   * zero on VAT only because VAT's plugins are assembled by copy-in. See the
   * comment at that call site for why it was left and what fixing it needs.
   */
  allowLedger?: AllowUsageLedger;
  /**
   * EVERY skill the project declares, with its effective packaging config.
   *
   * Read only for `test.evals`, and the rule it feeds is PROJECT-WIDE: a file any
   * skill declares as its eval suite is test input, and this lane must predict a
   * bundle without it — the same bundle `vat skills build` produces. Without this,
   * the lane counts a sibling skill's answer key as an ordinary bundled file, and
   * `vat skills validate` and `vat skills build` disagree about what ships.
   *
   * Assemble it ONCE per invocation from the lane's own skill discovery and pass the
   * same array to every skill; do not rebuild it per skill (that is a whole-project
   * config walk inside a per-skill loop). Omitting it is a positive claim that the
   * caller has no project to enumerate — true for a config-free single-skill audit,
   * false for anything that loops over discovered skills.
   */
  projectSkills?: readonly DeclaredEvalSuite[];
  /**
   * The RUN's conventional-suite probe — the memo behind "does `<skill-root>/evals/
   * evals.json` exist?" for every root in {@link projectSkills}.
   *
   * Scoped to the run for the same reason `projectSkills` is assembled once: the two
   * are the same question asked of the same S paths, and this lane asks it for the
   * SUBJECT and for every entry in `projectSkills`. A probe created per call answers
   * S questions per skill and S² per run — measured at 10,815 filesystem probes over
   * 103 distinct paths on a 103-skill adopter, half of that command's entire fs
   * traffic. Supply the SAME probe for every skill in the run.
   *
   * Omitting it is a positive claim that THIS call is the whole run — true for the
   * single-skill callers (`vat skill review`, `vat audit`, whose shared context is
   * built per skill), where the per-call and run-level answers coincide. False for
   * anything that loops, which is why the fallback below is written at the call site
   * rather than defaulted inside `resolveTestInputDirs`.
   */
  suiteProbe?: ConventionalSuiteProbe;
}

/**
 * Validate a skill for packaging
 *
 * Performs comprehensive validation including:
 * - Size/complexity checks
 * - Link depth analysis
 * - Navigation file detection
 * - Framework-based severity / allow config
 *
 * @param skillPath - Path to SKILL.md
 * @param packagingConfig - Optional packaging configuration (depth, excludes, validation)
 * @param context - Whether the skill is being validated from source or built output
 * @param shared - Optional shared context (registry + gitTracker) for batched runs
 * @returns Validation result with active errors, warnings, and allowed issues
 */
export async function validateSkillForPackaging(
  skillPath: string,
  packagingConfig?: SkillPackagingConfig,
  context: 'source' | 'built' = 'source',
  shared?: SkillValidationSharedContext,
): Promise<PackagingValidationResult> {
  const rawIssues: ValidationIssue[] = [];

  // Validation-POLICY boundary (config root -> git root -> skill dir): what is
  // "outside the project", where `files:` sources resolve from, what the
  // registry crawls. Library fallback to skill dir keeps callers null-safe; CLI
  // command boundary owns any user-facing warning. See plan 2026-05-17.
  const projectRoot = findProjectRoot(dirname(skillPath)) ?? dirname(skillPath);
  // ANCHOR base — deliberately a separate variable from projectRoot above.
  // Every emitted location is relative to this ONE root, computed once before
  // the first producer runs so no collector can pick a different base. A
  // batching caller supplies it; alone in a project the two coincide.
  const locationRoot = shared?.locationRoot ?? projectRoot;
  const skillLocation = issueLocation(skillPath, locationRoot);

  // Parse SKILL.md
  const parseResult = await parseFileCached(skillPath, 'markdown');
  // The parser already decoded these bytes; a second whole-file read of the same
  // path would only add a syscall and a TOCTOU window. `content` is the raw
  // source verbatim, so fenced code blocks reach `runCompatDetectors` intact.
  const skillContent = parseResult.content;
  const skillLines = skillContent.split('\n').length;

  // Validate frontmatter schema (name format, required fields, etc.)
  if (parseResult.frontmatter) {
    rawIssues.push(
      ...validateFrontmatterSchema(parseResult.frontmatter, false, skillLocation),
      ...validateFrontmatterRules(parseResult.frontmatter, skillLocation),
    );
  }

  // Compat capability detection: collect observations from SKILL.md and
  // surface each as a CAPABILITY_* issue. Observations are also returned
  // on the result so downstream verdict computation (CLI layer) can recover
  // payloads such as EXTERNAL_CLI binary names.
  const { evidence, observations } = runCompatDetectors(skillContent, skillPath, locationRoot);
  for (const obs of observations) {
    rawIssues.push(observationToIssue(obs, skillLocation));
  }

  // Read packaging options for depth/exclude configuration
  const linkFollowDepth = packagingConfig?.linkFollowDepth ?? 2;
  const excludeConfig = packagingConfig?.excludeReferencesFromBundle;
  const excludeNavigationFiles = packagingConfig?.excludeNavigationFiles ?? true;
  const maxDepth = linkFollowDepth === 'full' ? Infinity : linkFollowDepth;

  // Validate files config (requires projectRoot to resolve source paths for
  // directory-source detection — must run after projectRoot is computed).
  rawIssues.push(...validateFilesConfig(packagingConfig?.files, projectRoot, locationRoot));

  // Build resource registry and walk the link graph.
  // Prefer the caller-supplied shared registry (when `vat skills validate` or
  // similar batches multiple skills under the same project root) so the
  // per-file markdown parse is paid for exactly once across the batch. Only
  // reuse when the shared registry covers this skill's projectRoot; otherwise
  // fall back to a fresh crawl to avoid leaking resources across roots.
  const registry = shared?.registry !== undefined && registryCoversSkill(shared.registry, skillPath)
    ? shared.registry
    : await crawlAndResolveRegistry(projectRoot, {
      ...(shared?.populationSource !== undefined && { populationSource: shared.populationSource }),
    });

  const skillResource = registry.getResource(safePath.resolve(skillPath));
  // Only the entries the PACKAGER will actually copy defer a link: an entry pointing
  // into declared test input is dropped at build time, so its dest never appears and
  // a link to it is a genuine broken link — the same verdict `vat skills build`
  // reaches. Same derivation `packagedFileEntries` performs for the lanes that have
  // no second use for the dirs — see test-input.ts.
  //
  // `projectSkills` is the PROJECT's declared eval suites, assembled once by the
  // calling lane (see SkillValidationSharedContext.projectSkills). Empty when the
  // caller has no project to enumerate — a single-skill audit of a tree with no
  // config — which narrows this lane to the subject's own suite and nothing else.
  const projectSkills = shared?.projectSkills ?? [];
  // ONE resolution per skill, shared by both consumers below (the `files:` filter and
  // the walker's exclude rules), and ONE conventional-suite probe per RUN behind it.
  //
  // Two multipliers on the same filesystem question, both now closed. Resolving it
  // once per CONSUMER doubled the term for no new information (the two call sites took
  // identical arguments) — 6,844 probes on a 58-skill adopter declaring no `test:`
  // block, of which 3,422 re-asked a question already answered. That fix removed the
  // second call site and left the QUADRATIC standing: the resolution still probes the
  // subject AND every entry in `projectSkills`, so a lane looping over S skills asked
  // S^2 questions about S paths. Measured with the lab on a 103-skill adopter,
  // `vat resources validate`: 10,815 probes over 103 distinct paths (~105 repeats
  // each) — exactly 50% of that command's 21,648 user filesystem calls. With the run's
  // probe threaded here it is ~103 probes and ~10,900 calls on the same tree.
  //
  // A caller that omits `suiteProbe` is claiming this call IS the run (see the field's
  // docstring); the narrowing is written here, at the call site, so it cannot happen by
  // omission inside `resolveTestInputDirs`.
  const suiteProbe = shared?.suiteProbe ?? conventionalSuiteProbe();
  const testInputDirs = resolveTestInputDirs(
    packagingConfig ?? {}, dirname(skillPath), projectSkills, suiteProbe,
  );
  const packagedFiles = partitionTestInputFileEntries(
    packagingConfig?.files ?? [], projectRoot, testInputDirs,
  ).kept;
  const deferred = DeferredArtifacts.from(
    [{ files: packagedFiles, skillDir: dirname(skillPath) }],
    projectRoot,
  );

  // What the `files:` GLOBs will do to this build, reported HERE — before any
  // build — because this is where it is still cheap to act on: `vat skills
  // validate` and `vat audit` can expand the same globs the packager expands
  // without writing anything. Same expansion as the copy — see
  // collectPreBuildGlobFindings — so the two lanes cannot disagree about what
  // ships. Two populations, both load-bearing:
  //   - a never-package DROP is the only signal standing between a
  //     documentation-bearing glob base and a silent content loss the day someone
  //     adds a README.md to it;
  //   - a glob matching NOTHING is the input `vat skills build` dies on, and this
  //     gate is what adopters run before that build. Reporting the harmless drop
  //     while staying silent about the fatal zero-match was the asymmetry that
  //     let `vat skills validate` return success on a config that cannot build.
  rawIssues.push(
    ...preBuildGlobFindingsToIssues(
      await collectPreBuildGlobFindings(packagedFiles, projectRoot),
      locationRoot,
    ),
  );

  const walkOptions: Parameters<typeof walkLinkGraph>[2] = {
    maxDepth,
    // The SAME test-input exclusion the packager applies. Without it this lane
    // predicts a bundle containing the eval suite while the build produces one
    // without it — same input, two answers about what ships, from the two commands
    // that exist to agree.
    excludeRules: [
      ...(excludeConfig?.rules ?? []),
      ...testInputExcludeRules(testInputDirs, projectRoot),
    ],
    projectRoot,
    skillRootPath: safePath.resolve(skillPath),
    excludeNavigationFiles,
    deferredArtifacts: deferred,
  };
  if (shared?.gitTracker !== undefined) {
    walkOptions.gitTracker = shared.gitTracker;
  }
  const { bundledResources, bundledAssets, excludedReferences, maxBundledDepth, deferredAssets } = walkLinkGraph(
    skillResource?.id ?? '',
    registry as WalkableRegistry,
    walkOptions,
  );
  const bundledFiles = [...bundledResources.map(r => r.filePath), ...bundledAssets];

  // Count direct links that actually made it into the bundle
  const directLinks = getResolvedMarkdownLinks(parseResult.links, skillPath);
  const bundledFileSet = new Set(bundledFiles);
  const directFileCount = directLinks.filter(p => bundledFileSet.has(p)).length;

  // Three producers, one append, order significant. Each is a receipt for a link
  // the walker dropped or deferred, and all three anchor on `locationRoot`:
  //  1. walker exclusions (LINK_OUTSIDE_PROJECT, LINK_TARGETS_DIRECTORY, etc.)
  //  2. links dropped for pointing into declared test input — the same issue, at
  //     the same location, the packager emits for it. `projectRoot` scopes WHICH
  //     dirs count as declared test input; `locationRoot` only anchors.
  //  3. one info issue per deferred asset declared in files: config
  rawIssues.push(
    ...walkerExclusionsToIssues(excludedReferences, locationRoot),
    ...testInputLinkIssues(excludedReferences, testInputDirs, projectRoot, locationRoot),
    ...deferredAssetsToIssues(deferredAssets, locationRoot),
  );

  const fileCount = bundledFiles.length + 1; // +1 for SKILL.md itself
  const maxLinkDepth = maxBundledDepth;

  // Calculate total lines from bundled markdown files only, and scan each
  // reachable bundled doc for non-portable asset references (the agent reads
  // and copies invocations from reference files too, not just SKILL.md).
  let totalLines = skillLines;
  for (const bundledFile of bundledFiles) {
    if (bundledFile.endsWith('.md')) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bundledFile resolved from markdown parser
      const content = await readFile(bundledFile, 'utf-8');
      totalLines += content.split('\n').length;
      // Anchor contract: never hand a producer an absolute path as `location`.
      const bundledLocation = issueLocation(bundledFile, locationRoot);
      collectNonPortableAssetReferenceIssues(content, bundledLocation, rawIssues);
      collectNonPortableCommandIssues(content, bundledLocation, rawIssues);
    }
  }

  const excludedDetails = deduplicateExcludedReferences(excludedReferences, skillPath);

  // Run quality / best-practice checks
  collectSizeIssues(skillLines, totalLines, fileCount, maxLinkDepth, skillLocation, rawIssues);
  collectDescriptionIssue(parseResult.frontmatter, skillLocation, rawIssues);
  collectProgressiveDisclosureIssue(skillLines, bundledFiles.length, skillLocation, rawIssues);
  collectNameMismatchIssue(parseResult.frontmatter, skillPath, skillLocation, rawIssues);
  collectTimeSensitiveContentIssues(parseResult.content, skillLocation, rawIssues);
  collectNonPortableAssetReferenceIssues(parseResult.content, skillLocation, rawIssues);
  collectNonPortableCommandIssues(parseResult.content, skillLocation, rawIssues);

  // Cross-skill dependency smell: body declares a requires/depends token the
  // description does not mention. Uses the post-frontmatter content slice.
  if (parseResult.frontmatter) {
    rawIssues.push(...detectUndeclaredCrossSkillAuth(parseResult.frontmatter, parseResult.content, skillLocation));
  }

  // Filter out source-only codes when validating built output
  const filteredIssues = context === 'built'
    ? rawIssues.filter(issue => !SOURCE_ONLY_CODES.has(issue.code))
    : rawIssues;

  // Run through the unified validation framework.
  //
  // Two lanes, one question: a batching caller supplies the RUN's ledger and
  // owns the drain (ALLOW_UNUSED belongs to the run, not to whichever skill
  // happened to be validated when the entry went unmatched); a caller that
  // supplied none is claiming its run is this one skill, and gets the run-level
  // answer folded in here.
  const validationConfig = packagingConfig?.validation ?? {};
  const framework = shared?.allowLedger === undefined
    ? runSingleUnitValidation(filteredIssues, validationConfig)
    : runValidationFramework(filteredIssues, validationConfig, shared.allowLedger);

  const skillName = extractSkillName(parseResult, skillPath);

  return {
    skillName,
    status: framework.hasErrors ? 'error' : 'success',
    allErrors: framework.emitted,
    ignoredErrors: framework.allowed,
    observations,
    evidence,
    metadata: {
      skillLines,
      totalLines,
      fileCount,
      directFileCount,
      maxLinkDepth,
      excludedReferenceCount: excludedDetails.length,
      excludedReferences: excludedDetails,
    },
  };
}

/**
 * Collect size and depth validation issues
 */
function collectSizeIssues(
  skillLines: number,
  totalLines: number,
  fileCount: number,
  maxLinkDepth: number,
  skillLocation: string,
  issues: ValidationIssue[],
): void {
  if (skillLines > VALIDATION_THRESHOLDS.RECOMMENDED_SKILL_LINES) {
    const rule = VALIDATION_RULES.SKILL_LENGTH_EXCEEDS_RECOMMENDED;
    issues.push(registryIssueAt(
      rule.code as IssueCode,
      rule.message({ lines: skillLines }),
      skillLocation,
    ));
  }

  if (totalLines > VALIDATION_THRESHOLDS.MAX_TOTAL_LINES) {
    const rule = VALIDATION_RULES.SKILL_TOTAL_SIZE_LARGE;
    issues.push(registryIssueAt(
      rule.code as IssueCode,
      rule.message({ totalLines }),
      skillLocation,
    ));
  }

  if (fileCount > VALIDATION_THRESHOLDS.MAX_FILE_COUNT) {
    const rule = VALIDATION_RULES.SKILL_TOO_MANY_FILES;
    issues.push(registryIssueAt(
      rule.code as IssueCode,
      rule.message({ fileCount }),
      skillLocation,
    ));
  }

  if (maxLinkDepth > VALIDATION_THRESHOLDS.MAX_REFERENCE_DEPTH) {
    const rule = VALIDATION_RULES.REFERENCE_TOO_DEEP;
    issues.push(registryIssueAt(
      rule.code as IssueCode,
      rule.message({ depth: maxLinkDepth }),
      skillLocation,
    ));
  }
}

/**
 * Collect description quality issue (DESCRIPTION_TOO_VAGUE)
 */
function collectDescriptionIssue(
  frontmatter: Record<string, unknown> | undefined,
  skillLocation: string,
  issues: ValidationIssue[],
): void {
  const description = frontmatter?.['description'];

  if (!description || typeof description !== 'string') {
    return; // Missing description is handled by existing validator
  }

  if (description.length < VALIDATION_THRESHOLDS.MIN_DESCRIPTION_LENGTH) {
    const rule = VALIDATION_RULES.DESCRIPTION_TOO_VAGUE;
    issues.push(registryIssueAt(
      rule.code as IssueCode,
      rule.message({ length: description.length }),
      skillLocation,
    ));
  }
}

/**
 * Kebab-case pattern used by the Agent Skill schema for `name`. The check
 * only fires when the parent directory itself looks like a skill directory
 * (same kebab-case shape). This avoids false positives when SKILL.md lives
 * at a repo root or inside an unrelated container.
 */
const SKILL_DIR_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Generic container directory names that hold multiple skills in a flat layout.
 * When SKILL.md lives directly inside one of these, the parent dir name carries
 * no signal about what the skill is named — skip the mismatch check entirely.
 */
const GENERIC_CONTAINER_DIRS = new Set<string>(['skills', 'resources']);

/**
 * Detect SKILL_NAME_MISMATCHES_DIR issue from a frontmatter `name` and a
 * parent directory name. Returns null when no mismatch should be reported.
 *
 * Exported for direct unit testing — the packaging validator wires it up
 * with values derived from the skill path.
 */
export function detectNameMismatchIssue(
  frontmatterName: unknown,
  parentDir: string,
  skillLocation: string,
): ValidationIssue | null {
  if (typeof frontmatterName !== 'string' || frontmatterName.trim() === '') {
    return null;
  }
  if (parentDir === '' || parentDir === '.' || parentDir === 'SKILL.md') {
    return null;
  }
  if (!SKILL_DIR_NAME_PATTERN.test(parentDir)) {
    return null;
  }
  if (GENERIC_CONTAINER_DIRS.has(parentDir.toLowerCase())) {
    return null;
  }

  const normalize = (s: string): string => s.trim().toLowerCase();
  if (normalize(frontmatterName) === normalize(parentDir)) {
    return null;
  }

  const registryEntry = CODE_REGISTRY.SKILL_NAME_MISMATCHES_DIR;
  return {
    severity: registryEntry.defaultSeverity,
    code: 'SKILL_NAME_MISMATCHES_DIR',
    message: `Frontmatter name "${frontmatterName}" does not match parent directory "${parentDir}"`,
    location: skillLocation,
    fix: registryEntry.fix,
    reference: registryEntry.reference,
  };
}

/**
 * Collect SKILL_NAME_MISMATCHES_DIR issue. Skips when the skill lives in an
 * OS temp directory — unit tests and ad-hoc scratch runs don't have
 * meaningful parent-directory names.
 */
function collectNameMismatchIssue(
  frontmatter: Record<string, unknown> | undefined,
  skillPath: string,
  skillLocation: string,
  issues: ValidationIssue[],
): void {
  const resolvedSkillPath = toForwardSlash(safePath.resolve(skillPath));
  const resolvedTmpdir = toForwardSlash(safePath.resolve(normalizedTmpdir()));
  // eslint-disable-next-line local/no-path-startswith -- both operands are already toForwardSlash-normalized
  if (resolvedSkillPath.startsWith(`${resolvedTmpdir}/`)) {
    return;
  }

  const parentDir = basename(dirname(skillPath));
  const issue = detectNameMismatchIssue(frontmatter?.['name'], parentDir, skillLocation);
  if (issue !== null) {
    issues.push(issue);
  }
}

/**
 * Time-sensitive content patterns. Case-insensitive.
 * Matches: "as of <month> YYYY", "after/before/until <month> YYYY",
 * and the year-first form "as of YYYY-MM".
 */
const MONTH_NAME_PATTERN = '(?:january|february|march|april|may|june|july|august|september|october|november|december)';
/* eslint-disable security/detect-non-literal-regexp -- compile-time constant patterns composed from MONTH_NAME_PATTERN, no user input */
const TIME_SENSITIVE_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\bas of ${MONTH_NAME_PATTERN} \d{4}\b`, 'i'),
  new RegExp(String.raw`\bafter ${MONTH_NAME_PATTERN} \d{4}\b`, 'i'),
  new RegExp(String.raw`\bbefore ${MONTH_NAME_PATTERN} \d{4}\b`, 'i'),
  new RegExp(String.raw`\buntil ${MONTH_NAME_PATTERN} \d{4}\b`, 'i'),
  /\bas of \d{4}-\d{2}\b/i,
];
/* eslint-enable security/detect-non-literal-regexp */

/**
 * A member of a *portability check family*. Each variant detects one specific
 * non-portable pattern; all variants in a family roll up to a single registry
 * code so one `validation.allow` entry (or severity override) silences the whole
 * concern for a file — adding an esoteric check never explodes the override
 * surface. Each variant still carries its own `label` (named in the finding) and
 * `fix` (tailored remediation), so the guidance stays specific. Extend a family
 * by appending a row.
 */
interface PortabilityVariant {
  /** Short stable id for the sub-check, surfaced in the finding message. */
  readonly label: string;
  readonly pattern: RegExp;
  /** Variant-specific remediation shown as the finding's `fix`. */
  readonly fix: string;
}

/**
 * The NON_PORTABLE_ASSET_REFERENCE family — ways a skill document hard-codes a
 * path to a bundled asset that won't resolve across the surfaces a skill runs on
 * (Claude Code plugin, claude.ai upload, API container).
 *
 * Patterns are case-sensitive (env vars are upper-case; lowercase prose mentions
 * are not flagged).
 */
const RELATIVE_PATH_HINT =
  'Reference bundled files by a path relative to the skill directory (e.g. `scripts/run.mjs`).';

/**
 * Match `$NAME` or `${NAME}`, without ever consuming a brace that belongs to an
 * enclosing expansion.
 *
 * A naive `\$\{?NAME\}?` mis-captures inside nested parameter expansion: given
 * `"${VAR:-$CLAUDE_PROJECT_DIR}"` the optional trailing `\}?` eats the closing
 * brace of the *outer* `${…:-…}`, and the finding reads `"$CLAUDE_PROJECT_DIR}"`
 * — which looks exactly like the typo `$FOO}` for `${FOO}` and sends reviewers
 * to a file that is in fact correct shell.
 *
 * The two alternatives, in order:
 *  1. `\$\{NAME\}` — the fully-braced form `${NAME}`, captured *with* its own
 *     closing brace so the message renders it intact.
 *  2. `\$\{?NAME\b` — a bare `$NAME` or a braced expansion that carries an
 *     operator (`${NAME:-…}`, `${NAME#…}`, `${NAME/…}`), matched only up to the
 *     word boundary after NAME so it never swallows a brace that isn't the
 *     variable's own. Trying (1) first is what keeps the closing brace on the
 *     plain form; falling to (2) is what still flags the operator forms — a
 *     lone `\$\{NAME\}` alternative silently missed `${NAME:-default}`, an
 *     idiomatic non-portable reference.
 */
// eslint-disable-next-line security/detect-non-literal-regexp -- composed from a compile-time constant name, no user input
const envVarPattern = (name: string): RegExp => new RegExp(String.raw`\$\{${name}\}|\$\{?${name}\b`);

const NON_PORTABLE_ASSET_VARIANTS: readonly PortabilityVariant[] = [
  {
    label: 'claude-plugin-root',
    pattern: envVarPattern('CLAUDE_PLUGIN_ROOT'),
    fix: `\`CLAUDE_PLUGIN_ROOT\` is a Claude Code plugin-only variable that points at the plugin, not the skill, and is absent under standalone mounts. ${RELATIVE_PATH_HINT}`,
  },
  {
    // NOT an asset reference. CLAUDE_PROJECT_DIR denotes the *user's repository*
    // — the thing the skill operates on — so there is no skill-relative path
    // that can express it and the RELATIVE_PATH_HINT advice does not apply.
    // Advising it here actively misleads: an adopter reported that the pattern
    // this flags (`--project-dir` → `$CLAUDE_PROJECT_DIR` → cwd) was their *fix*
    // for anchoring user artifacts on the plugin install dir by mistake.
    label: 'claude-project-dir',
    pattern: envVarPattern('CLAUDE_PROJECT_DIR'),
    fix: '`CLAUDE_PROJECT_DIR` is a Claude Code-only variable, so a skill relying on it will not resolve the user\'s project on other runtimes. There is no skill-relative equivalent — if the skill genuinely operates on the user\'s repository, take the location as an explicit parameter with `$CLAUDE_PROJECT_DIR` as a fallback, and make sure the skill\'s declared `targets` reflect the Claude Code dependency.',
  },
  {
    label: 'absolute-script-path',
    pattern: /\b(?:node|bun|deno|python3?|ruby|sh|bash|uv)\s+["']?\/[^\s"']+\.(?:mjs|cjs|js|ts|py|rb|sh)\b/,
    fix: `An absolute path to a bundled script will not exist on another machine or runtime. ${RELATIVE_PATH_HINT}`,
  },
];

/**
 * The NON_PORTABLE_COMMAND family — ways a skill document instructs an agent to
 * run a shell command that hard-codes a GNU/Linux-only utility or flag. The agent
 * copies these invocations verbatim, so a command that only works on Linux fails
 * the moment the skill runs on macOS/BSD.
 *
 * Patterns match commands in *command position* only (start of line, or after a
 * pipe/semicolon/ampersand or a backtick/code fence) so bare prose nouns
 * ("the request will timeout", "grep the logs") are not flagged. See
 * COMMAND_POSITION / COMMAND_SEGMENT below.
 *
 * Every `fix` below asserts how a utility behaves on macOS/BSD. The CI matrix is
 * Ubuntu + Windows only, so no test in this repo can contradict these claims —
 * they are vendor claims and go stale silently. The `readlink-f` variant already
 * did: `-f` was absent from macOS for years, and is present and working as of
 * macOS 26.5.2. When a variant's macOS behaviour converges with GNU, DELETE the
 * variant — do not reword it, or the detector trains adopters to ignore the code.
 *
 * @vendor-claim reviewed=2026-07-29 verify=On a current macOS, run each variant against the system binaries rather than Homebrew coreutils — `ls /usr/bin/timeout`, `echo x | /usr/bin/grep -P x`, `/usr/bin/sed -i s/a/b/ FILE`, `/usr/bin/readlink -f ./missing.txt`, `/bin/date -d 2020-01-01` — and run the GNU counterparts on Linux to confirm the difference still exists
 */
/* eslint-disable security/detect-non-literal-regexp -- compile-time constants composed from COMMAND_POSITION/COMMAND_SEGMENT, no user input */
// Command position: start of line, or after a pipe/semicolon/ampersand or a
// backtick (\x60). Leading whitespace is consumed so indented code blocks match.
const COMMAND_POSITION = String.raw`(?:^|[|;&\x60])\s*`;
// One command segment: characters up to the next separator (lazy), used to skip
// over leading flags/args before the non-portable flag the variant looks for.
const COMMAND_SEGMENT = String.raw`[^\n|;&\x60]*?`;

const NON_PORTABLE_COMMAND_VARIANTS: readonly PortabilityVariant[] = [
  {
    label: 'timeout',
    // `timeout <arg>` in command position; requires an argument so backtick-wrapped
    // lone mentions (`timeout`) and object keys (`timeout:`) are not flagged.
    pattern: new RegExp(COMMAND_POSITION + String.raw`timeout\s+\S+`),
    fix: '`timeout` is not installed on macOS by default. Gate on its availability (`command -v timeout`), use a portable alternative, or drop it.',
  },
  {
    label: 'grep-pcre',
    pattern: new RegExp(COMMAND_POSITION + String.raw`grep\b` + COMMAND_SEGMENT + String.raw`\s(?:-[A-Za-z]*P|--perl-regexp)\b`),
    fix: 'PCRE (`grep -P` / `--perl-regexp`) is unsupported by BSD/macOS grep. Use `grep -E` (extended regex) instead.',
  },
  {
    label: 'sed-i-no-backup',
    // `sed -i` followed by whitespace/end (no attached suffix). GNU `sed -i` and
    // BSD `sed -i ''` differ; `sed -i.bak` (attached suffix) is portable and is
    // not flagged (the `-i` here is followed by `.`, not whitespace).
    pattern: new RegExp(COMMAND_POSITION + String.raw`sed\b` + COMMAND_SEGMENT + String.raw`\s-i(?=\s|$)`),
    fix: 'GNU `sed -i` and BSD `sed -i \'\'` differ. Pass an explicit suffix (`sed -i.bak ...`) or write to a temp file and move it back.',
  },
  {
    label: 'readlink-f',
    pattern: new RegExp(COMMAND_POSITION + String.raw`readlink\b` + COMMAND_SEGMENT + String.raw`\s-[a-z]*f\b`),
    fix: '`readlink -f` is not portable: on macOS it fails (exit 1, no output) when the final path component does not exist, where GNU canonicalizes it, and `-f` was absent from macOS entirely for years. Use a portable resolve (e.g. a `cd "$(dirname …)" && pwd` shell function or a Node/Python one-liner).',
  },
  {
    label: 'date-d',
    pattern: new RegExp(COMMAND_POSITION + String.raw`date\b` + COMMAND_SEGMENT + String.raw`\s-d\b`),
    fix: 'GNU `date -d` is not supported by BSD/macOS `date`, which uses `-v` or `-j -f`. Avoid `-d` or branch on the platform.',
  },
];
/* eslint-enable security/detect-non-literal-regexp */

/**
 * Collect SKILL_TIME_SENSITIVE_CONTENT issues — scan the SKILL.md body for
 * time-sensitive prose that may become stale. One issue per distinct match
 * with line-number location.
 */
function collectTimeSensitiveContentIssues(
  content: string,
  skillLocation: string,
  issues: ValidationIssue[],
): void {
  const registryEntry = CODE_REGISTRY.SKILL_TIME_SENSITIVE_CONTENT;
  const lines = content.split('\n');

  for (const [index, line] of lines.entries()) {
    for (const pattern of TIME_SENSITIVE_PATTERNS) {
      const match = pattern.exec(line);
      if (match !== null) {
        const lineNumber = index + 1;
        issues.push({
          severity: registryEntry.defaultSeverity,
          code: 'SKILL_TIME_SENSITIVE_CONTENT',
          message: `Time-sensitive phrase "${match[0]}" may become stale`,
          location: skillLocation,
          line: lineNumber,
          fix: registryEntry.fix,
          reference: registryEntry.reference,
        });
        // Only emit one issue per line (first match wins)
        break;
      }
    }
  }
}

/**
 * Scan one skill document for any member of a portability check family. One issue
 * per line (first matching variant wins), anchored at `docLocation` + `line`, carrying the
 * variant's label and tailored fix. Shared by the NON_PORTABLE_ASSET_REFERENCE and
 * NON_PORTABLE_COMMAND families.
 */
function collectPortabilityFamilyIssues(
  content: string,
  docLocation: string,
  issues: ValidationIssue[],
  family: {
    readonly code: IssueCode;
    readonly variants: readonly PortabilityVariant[];
    readonly summarize: (label: string, match: string) => string;
  },
): void {
  const registryEntry = CODE_REGISTRY[family.code];
  const lines = content.split('\n');

  for (const [index, line] of lines.entries()) {
    for (const variant of family.variants) {
      const match = variant.pattern.exec(line);
      if (match !== null) {
        issues.push({
          severity: registryEntry.defaultSeverity,
          code: family.code,
          message: family.summarize(variant.label, match[0].trim()),
          location: docLocation,
          line: index + 1,
          fix: variant.fix,
          reference: registryEntry.reference,
        });
        // Only emit one issue per line (first matching variant wins)
        break;
      }
    }
  }
}

/**
 * Collect NON_PORTABLE_ASSET_REFERENCE issues — scan one skill document for any
 * member of the non-portable asset-reference family.
 */
function collectNonPortableAssetReferenceIssues(
  content: string,
  docLocation: string,
  issues: ValidationIssue[],
): void {
  collectPortabilityFamilyIssues(content, docLocation, issues, {
    code: 'NON_PORTABLE_ASSET_REFERENCE',
    variants: NON_PORTABLE_ASSET_VARIANTS,
    // The headline names the finding only; remediation differs per variant (a
    // skill-relative path is the answer for bundled assets but is meaningless
    // for CLAUDE_PROJECT_DIR), so the advice lives in each variant's `fix`.
    summarize: (label, match) =>
      `Non-portable reference [${label}]: "${match}" — will not resolve on every surface this skill can run on`,
  });
}

/**
 * Collect NON_PORTABLE_COMMAND issues — scan one skill document for any member of
 * the non-portable shell-command family.
 */
function collectNonPortableCommandIssues(
  content: string,
  docLocation: string,
  issues: ValidationIssue[],
): void {
  collectPortabilityFamilyIssues(content, docLocation, issues, {
    code: 'NON_PORTABLE_COMMAND',
    variants: NON_PORTABLE_COMMAND_VARIANTS,
    // Strip the leading command-position separator (backtick / pipe / etc.) the
    // pattern captured, so the message shows just the command.
    summarize: (label, match) =>
      `Non-portable command [${label}]: "${match.replace(/^[`|;&\s]+/, '')}" — fails on macOS/BSD; use a portable equivalent`,
  });
}

/**
 * Collect progressive disclosure issue (NO_PROGRESSIVE_DISCLOSURE)
 */
function collectProgressiveDisclosureIssue(
  skillLines: number,
  referenceFileCount: number,
  skillLocation: string,
  issues: ValidationIssue[],
): void {
  if (skillLines > VALIDATION_THRESHOLDS.RECOMMENDED_SKILL_LINES && referenceFileCount === 0) {
    const rule = VALIDATION_RULES.NO_PROGRESSIVE_DISCLOSURE;
    issues.push(registryIssueAt(
      rule.code as IssueCode,
      rule.message({ lines: skillLines }),
      skillLocation,
    ));
  }
}

/**
 * Process links from parsed markdown and return resolved .md file paths.
 *
 * Exported for unit test: the deduplication contract (one entry, and one existence
 * probe, per DISTINCT target however many times it is linked) is not observable
 * through `validateSkillForPackaging`'s result alone.
 */
export function getResolvedMarkdownLinks(
  links: Array<{ href: string; type: string }>,
  markdownPath: string
): string[] {
  const markdownDir = dirname(markdownPath);

  // Collapse to DISTINCT targets before touching the filesystem. `links` is one
  // entry per link OCCURRENCE, and documents routinely point many occurrences at
  // one file (a routing table linking every row to the same sub-skill). Two
  // consequences, both fixed here rather than downstream:
  //   - the caller derives `directFileCount` from this list, so occurrences made
  //     it report more direct files than the whole bundle holds;
  //   - the existence probe below ran once per occurrence. On this repo's own
  //     cat-agents skill that was 42 probes over 9 distinct paths.
  // A Set preserves insertion order, so the surviving order is unchanged.
  const candidates = new Set<string>();
  for (const link of links) {
    if (link.type !== 'local_file') {
      continue;
    }

    // Remove anchor
    const hrefWithoutAnchor = link.href.split('#')[0] ?? link.href;
    if (hrefWithoutAnchor === '') {
      continue;
    }

    const resolvedPath = safePath.resolve(markdownDir, hrefWithoutAnchor);

    // Only .md targets are candidates; existence is settled once, below.
    if (resolvedPath.endsWith('.md')) {
      candidates.add(resolvedPath);
    }
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path constructed from parsed markdown
  return [...candidates].filter(candidate => existsSync(candidate));
}

/**
 * Reasons that are reported as validation errors instead of excluded references.
 * These are filtered out of the excluded references list.
 */
const EXCLUDE_REASON_UNREADABLE = 'unreadable-target' as const;
const VALIDATION_ERROR_REASONS: ReadonlySet<string> = new Set([
  EXCLUDE_REASON_DIRECTORY,
  EXCLUDE_REASON_OUTSIDE_PROJECT,
  EXCLUDE_REASON_UNREADABLE,
]);

/**
 * Deduplicate excluded references by path, preserving detail from first occurrence.
 * Filters out entries reported as validation errors (directory-target, outside-project).
 */
function deduplicateExcludedReferences(
  excludedReferences: LinkResolution[],
  skillPath: string,
): ExcludedReferenceDetail[] {
  const seenPaths = new Set<string>();
  const details: ExcludedReferenceDetail[] = [];

  for (const ref of excludedReferences) {
    if (VALIDATION_ERROR_REASONS.has(ref.excludeReason ?? '')) {
      continue;
    }
    if (seenPaths.has(ref.path)) {
      continue;
    }
    seenPaths.add(ref.path);
    const matchedPattern = ref.matchedRule?.patterns[0];
    const reason = mapExcludeReason(ref.excludeReason);
    details.push({
      path: toForwardSlash(safePath.relative(dirname(skillPath), ref.path)),
      reason,
      ...(matchedPattern === undefined ? {} : { matchedPattern }),
    });
  }

  return details;
}

/** Map walk-link-graph exclude reasons to detail reasons */
function mapExcludeReason(
  excludeReason: LinkResolution['excludeReason'],
): ExcludedReferenceDetail['reason'] {
  switch (excludeReason) {
    case 'pattern-matched': return 'pattern-matched';
    case 'navigation-file': return 'navigation-file';
    case 'agent-instruction-file': return 'agent-instruction-file';
    case 'skill-definition': return 'skill-definition';
    case 'gitignored': return 'gitignored';
    // Reported under its own name rather than falling into the default arm.
    // The default answers `depth-exceeded`, which for this reason would be
    // false: the walk never reached the edge at all, because the file holding
    // it is not one VAT routes through.
    case 'non-routable-source': return 'non-routable-source';
    case 'depth-exceeded':
    case EXCLUDE_REASON_DIRECTORY:
    case EXCLUDE_REASON_OUTSIDE_PROJECT:
    case EXCLUDE_REASON_UNREADABLE:
    case 'missing-target':
    case undefined:
    default:
      return DETAIL_REASON_DEPTH;
  }
}

/**
 * Extract skill name from parse result
 */
function extractSkillName(
  parseResult: { frontmatter?: Record<string, unknown>; content: string },
  skillPath: string
): string {
  // Try frontmatter name
  const frontmatterName = parseResult.frontmatter?.['name'];
  if (frontmatterName && typeof frontmatterName === 'string') {
    return frontmatterName;
  }

  // Try H1 title. `[ \t]` is a single fixed-width class, not a quantifier, so it
  // cannot compete with the `[^\n]*` capture for the same space — that ambiguity
  // is what made the old `\s+([^\n]+)` form backtrack super-linearly. Trailing
  // whitespace is removed by the .trim() below, exactly as before.
  const h1Match = /^#[ \t]([^\n]*)$/m.exec(parseResult.content);
  if (h1Match?.[1]) {
    return h1Match[1].trim();
  }

  // Fall back to filename
  return basename(skillPath, '.md');
}

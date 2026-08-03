/**
 * Skill packaging - bundle SKILL.md with all linked resources
 *
 * This module provides the unified packaging logic used by all flows:
 * - Direct packaging of existing SKILL.md files
 * - Post-processing after generating SKILL.md from agent.yml
 *
 * Package formats supported:
 * - directory: Ready-to-use directory structure
 * - zip: Single file archive (preferred for Windows compatibility)
 * - npm: Standard npm package with package.json
 * - marketplace: JSON manifest for plugin registries
 *
 * Uses ResourceRegistry + transformContent() from @vibe-agent-toolkit/resources
 * for link resolution and rewriting (replacing the previous inline regex approach).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import {
  allowUnusedIssues,
  createAllowUsageLedger,
  runValidationFramework,
  type AllowUsageLedger,
  type FrameworkResult,
  type ValidationConfig,
  type ValidationIssue,
} from '@vibe-agent-toolkit/agent-schema';
import {
  DeferredArtifacts,
  ResourceRegistry,
  loadConfig,
  openFrontmatter,
  resolveLocalHref,
  rewriteFrontmatterUriReferencesFromSchema,
  rewriteHtmlLinks,
  transformContent,
  type LinkRewriteRule,
  type ParseResult,
  type ProjectConfig,
  type ResourceMetadata,
  parseMarkdown,
} from '@vibe-agent-toolkit/resources';
import {
  findProjectRoot,
  isGlob,
  issueLocation,
  resolveAssetReference,
  toForwardSlash,
  safePath,
  type GitTracker,
} from '@vibe-agent-toolkit/utils';

import { CLAUDE_WEB_REFERENCES_SUBDIR, getTargetSubdir } from './content-type-routing.js';
import {
  applyFilesConfig,
  buildArtifactHint,
  droppedGlobMatchesToIssues,
  explicitFilesConfigDests,
  globEntryDest,
  type SkillFileEntry,
} from './files-config.js';
import { checkBrokenPackagedLinks, checkUnreferencedFiles } from './post-build-checks.js';
import {
  checkPackagedTestInput,
  partitionTestInputFileEntries,
  resolveTestInputDirs,
  type DeclaredEvalSuite,
  testInputExcludeRules,
  testInputFileEntryIssues,
  testInputLinkIssues,
} from './test-input.js';
import { detectPackagedAgentInstructionFiles } from './validators/agent-instruction-presence.js';
import { validateSkillForPackaging, type PackagingValidationResult, type SkillPackagingConfig } from './validators/packaging-validator.js';
import { materializeIssue } from './validators/rule-engine/index.js';
import { deferredAssetsToIssues, walkerExclusionsToIssues } from './validators/walker-to-issues.js';
import { walkLinkGraph, type WalkableRegistry } from './walk-link-graph.js';

const PACKAGE_JSON_FILENAME = 'package.json';

/**
 * Default template for excluded links when no explicit template is configured —
 * renders just the link text.
 *
 * `{{link.rawText}}`, not `{{link.text}}`, for the same two reasons the rewrite
 * branch uses it (see `bundledLinkTemplate`):
 *
 *  - **Correlation.** `transformContent` keys parsed links by href and lets the
 *    FIRST occurrence win, so `link.text` on a second link sharing that href is
 *    the first link's text. `rawText` is the regex's per-occurrence capture, so it
 *    always belongs to the link being replaced. Stripping with `link.text` swapped
 *    one phrase for an unrelated one in shipped prose; the rewrite branch never
 *    exposed it because it re-emits `rawText`.
 *  - **Formatting.** `rawText` keeps the inline markup the author wrote, so
 *    ``[`foo.yaml`](…)`` strips to ``` `foo.yaml` ``` rather than bare `foo.yaml`.
 *
 * Text was the ONLY field the collision could corrupt: the map key is the full
 * href including any `#fragment`, so two links that collide there necessarily
 * resolve to the same resource and carry the same fragment.
 */
const DEFAULT_STRIP_TEMPLATE = '{{link.rawText}}';

/**
 * Template for a link the bundle is expected to carry: rewrite it to the target's
 * packaged location, or — when there IS no packaged location — strip it to plain
 * text with `stripTemplate`.
 *
 * The `else` branch is the whole point. `link.resource.relativePath` is undefined
 * for any target the OUTPUT registry does not hold, and three ordinary link shapes
 * land there:
 *
 *   - a non-markdown asset dropped from the bundle (`evals/evals.json`) — the
 *     registry indexes markdown, so a pattern exclude rule matching `filePath`
 *     never sees it and it falls through to here;
 *   - a link to a DIRECTORY, in either spelling (`refs/` or `refs`);
 *   - any other unresolved target.
 *
 * Rendering the rewrite branch anyway produced `[text]()` — a syntactically valid
 * markdown link to nowhere — or, for the slash spelling of a directory (which
 * matched no rule at all before this template took `local_directory` too), the
 * original href pointing at a path that does not exist in the output. The latter
 * then failed the build under `PACKAGED_BROKEN_LINK`, whose own remediation text
 * reads "Report the issue — this indicates a VAT bug."
 *
 * A directory link can never survive packaging: the packager FLATTENS every
 * bundled resource into `resources/`, so no authored directory exists in the
 * output to point at. Stripping to plain text keeps the author's prose and drops
 * the dead navigation — the same thing an excluded file link does.
 *
 * A SAME-DOCUMENT anchor (`[See below](#heading)`) is untouched by all of this: it
 * classifies as `anchor`, not a local target, so it matches none of these rules and
 * survives verbatim. Verified by test rather than assumed — an earlier draft carried
 * a special case for it that could never fire.
 */
function bundledLinkTemplate(stripTemplate: string): string {
  return (
    '{{#if link.resource.relativePath}}' +
    '[{{link.rawText}}]({{link.resource.relativePath}}{{link.fragment}})' +
    '{{else}}' +
    stripTemplate +
    '{{/if}}'
  );
}

/**
 * Resource naming strategy type
 */
export type ResourceNamingStrategy = 'basename' | 'resource-id' | 'preserve-path';

/**
 * Packaging target: determines ZIP directory structure
 * - 'claude-code': Standard VAT format with resources/ subdirectory (default)
 * - 'claude-web': Claude.ai web upload format with references/, scripts/, assets/ subdirectories
 */
export type PackagingTarget = 'claude-code' | 'claude-web';

/** Default packaging target */
const DEFAULT_PACKAGING_TARGET: PackagingTarget = 'claude-code';

export interface PackageSkillOptions {
  /**
   * Output directory for packaged skill
   * Default: <skill-package-root>/dist/skills/<skill-name>
   */
  outputPath?: string;

  /**
   * Package format(s) to generate
   * Default: ['directory']
   */
  formats?: ('directory' | 'zip' | 'npm' | 'marketplace')[];

  /**
   * Whether to rewrite links to be relative to package root
   * Default: true
   */
  rewriteLinks?: boolean;

  /**
   * Base path for resolving relative links in SKILL.md
   * Default: dirname(skillPath)
   */
  basePath?: string;

  /**
   * Strategy for naming packaged resource files
   *
   * - 'basename': Use original filename only (default, may cause conflicts)
   * - 'resource-id': Flatten path to kebab-case filename (descriptive, unique)
   * - 'preserve-path': Preserve directory structure in output
   *
   * Default: 'basename'
   *
   * @example
   * // Original: knowledge-base/guides/topics/quickstart/overview.md
   * // basename:       overview.md (may conflict)
   * // resource-id:    guides-topics-quickstart-overview.md (with stripPrefix: 'knowledge-base-')
   * // preserve-path:  guides/topics/quickstart/overview.md (creates subdirectories)
   */
  resourceNaming?: ResourceNamingStrategy;

  /**
   * Path prefix to strip before applying naming strategy
   *
   * Removes a directory prefix from the relative path before the naming strategy is applied.
   * Works with both 'resource-id' and 'preserve-path' strategies.
   *
   * @example
   * // Original: knowledge-base/guides/topics/quickstart/overview.md
   * // stripPrefix: 'knowledge-base'
   * //
   * // resource-id:    guides-topics-quickstart-overview.md
   * // preserve-path:  guides/topics/quickstart/overview.md
   */
  stripPrefix?: string;

  /** How deep to follow markdown links (default: 2) */
  linkFollowDepth?: number | 'full' | undefined;

  /** Whether to exclude navigation files (README.md, index.md, etc.) from bundle (default: true) */
  excludeNavigationFiles?: boolean | undefined;

  /** Exclude patterns and rewrite templates for non-bundled links */
  excludeReferencesFromBundle?: {
    rules?: Array<{
      patterns: string[];
      template?: string | undefined;
    }> | undefined;
    defaultTemplate?: string | undefined;
  } | undefined;

  /**
   * Pre-built ResourceRegistry for the project.
   * When provided, packageSkill() skips creating its own registry.
   * Used by packageSkills() to share a single registry across multiple skill builds.
   */
  registry?: ResourceRegistry | undefined;

  /**
   * Pre-populated {@link GitTracker} for the containing repo.
   *
   * When supplied, gitignore checks during the link-graph walk become O(1)
   * active-set lookups instead of `git check-ignore` spawns. Used by batched
   * build paths (e.g. `vat skills build`) that already constructed a tracker
   * for discovery/scanning.
   */
  gitTracker?: GitTracker | undefined;

  /**
   * Packaging target — controls the ZIP directory structure produced.
   *
   * - 'claude-code' (default): Standard VAT layout with resources/ subdirectory
   * - 'claude-web': Claude.ai web upload layout with references/, scripts/, assets/ subdirectories
   *
   * Default: 'claude-code'
   */
  target?: PackagingTarget | undefined;

  /**
   * Explicit file mappings for build artifacts, unlinked files, or routing overrides.
   *
   * Each entry copies source to dest in the skill output. Links matching
   * files[].source are rewritten to dest. Links matching files[].dest are
   * left as-is (assumed to be build artifacts placed at dest during build).
   */
  files?: SkillFileEntry[] | undefined;

  /**
   * Validation framework configuration: severity overrides and per-path allow entries.
   * See docs/validation-codes.md for codes and defaults.
   */
  validation?: ValidationConfig | undefined;

  /**
   * Absolute directories holding this skill's DECLARED test input (its eval suite).
   * Links into them are excluded from the bundle, and anything that still reaches
   * the output emits `PACKAGED_TEST_INPUT`. Derived from the skill's `test.evals`
   * by {@link resolveTestInputDirs} — see test-input.ts for why test input must
   * never ship.
   */
  testInputDirs?: string[] | undefined;

  /**
   * The RUN's allow-entry usage ledger.
   *
   * `validation.allow` is declared once per package but evaluated once per
   * skill AND once per lane, so "this entry matched nothing" is a question only
   * the whole invocation can answer. A caller that builds more than one skill,
   * or that validates the SOURCE tree before packaging (`vat build` does both),
   * MUST supply one ledger for the whole invocation and drain it itself with
   * `allowUnusedIssues()` after the last skill.
   *
   * Omitting it is a positive claim that THIS `packageSkill` call is the whole
   * run — true for single-skill library callers, who get the run-level verdict
   * folded into `postBuildIssues` here. It is false for anything that loops.
   */
  allowLedger?: AllowUsageLedger | undefined;
}

/**
 * Map a merged {@link SkillPackagingConfig} onto {@link PackageSkillOptions}.
 *
 * The single canonical conversion used by BOTH `vat skills build` and
 * `vat skill test` (the pool build), so the dist a test exercises is byte-for-byte
 * what `vat skills build` would produce. `basePath` defaults to `dirname(skillPath)`.
 *
 * `projectSkills` is EVERY skill the project declares, with its effective packaging
 * config — assembled ONCE per invocation by the calling lane and passed down, never
 * recomputed per skill (a per-skill walk of the whole project config is an N+1 this
 * repo has been bitten by). It is required rather than defaulted because the test-input
 * rule is project-wide: omitting it silently packages another skill's eval answer key.
 * A lane with genuinely no project to enumerate passes `[]` explicitly.
 */
export function packagingConfigToPackageOptions(
  config: SkillPackagingConfig,
  anchors: { skillPath: string; outputPath: string },
  projectSkills: readonly DeclaredEvalSuite[],
): PackageSkillOptions {
  return {
    outputPath: anchors.outputPath,
    formats: ['directory'],
    rewriteLinks: true,
    basePath: dirname(anchors.skillPath),
    ...(config.resourceNaming && { resourceNaming: config.resourceNaming }),
    ...(config.stripPrefix && { stripPrefix: config.stripPrefix }),
    ...(config.linkFollowDepth !== undefined && { linkFollowDepth: config.linkFollowDepth }),
    // `!== undefined`, not truthiness: `false` is the only value that carries
    // information here (the packager defaults to `true`), so a truthiness spread
    // would drop exactly the setting a user bothered to write. Dropping it made
    // this conversion disagree with `packaging-validator.ts`, which reads the same
    // key straight off the config — the gate predicted a README ships and the
    // build stripped it, from one config, inside the conversion that promises
    // byte-for-byte parity between lanes.
    ...(config.excludeNavigationFiles !== undefined && {
      excludeNavigationFiles: config.excludeNavigationFiles,
    }),
    ...(config.excludeReferencesFromBundle && { excludeReferencesFromBundle: config.excludeReferencesFromBundle }),
    ...(config.files && { files: config.files }),
    ...(config.validation && { validation: config.validation }),
    // Declared test input never ships. Derived here — the ONE conversion both
    // `vat skills build` and the plugin build go through — so no lane can package a
    // skill without the rule applied. PROJECT-WIDE: `projectSkills` carries every
    // other skill's declaration too, so a link into a SIBLING skill's suite is
    // excluded as well. Keyed to this skill alone, that sibling's answer key was
    // ordinary content and shipped.
    ...(() => {
      const testInputDirs = resolveTestInputDirs(config, dirname(anchors.skillPath), projectSkills);
      return testInputDirs.length > 0 ? { testInputDirs } : {};
    })(),
  };
}

export interface SkillMetadata {
  name: string;
  description?: string;
  version?: string;
  license?: string;
  author?: string;
}

export interface PackageSkillResult {
  /**
   * Path to packaged skill directory
   */
  outputPath: string;

  /**
   * Skill metadata extracted from frontmatter
   */
  skill: SkillMetadata;

  /**
   * Files included in package
   */
  files: {
    root: string;           // SKILL.md
    dependencies: string[]; // All linked files (relative paths)
  };

  /**
   * Package artifacts generated
   */
  artifacts?: {
    directory?: string;     // dist/skills/cat-agents/
    zip?: string;          // dist/skills/cat-agents.zip
    npm?: string;          // dist/skills/cat-agents.tgz
    marketplace?: string;  // dist/skills/cat-agents.marketplace.json
  };

  /** References excluded from bundle */
  excludedReferences?: string[] | undefined;

  /**
   * Post-build integrity issues — issues that the override config did NOT suppress.
   * Empty (or omitted) means all post-build checks passed.
   */
  postBuildIssues?: ValidationIssue[] | undefined;

  /** Full validation result against the built output. */
  postBuildValidation?: PackagingValidationResult | undefined;

  /** True when any emitted issue has resolved severity 'error'. */
  hasErrors: boolean;
}

/**
 * Specification for building a single skill. Used with packageSkills().
 */
export interface SkillBuildSpec {
  /** Absolute path to the SKILL.md file */
  skillPath: string;
  /** Packaging options for this skill */
  options: PackageSkillOptions;
}

/**
 * What ONE skill in a `packageSkills` batch produced.
 *
 * A discriminated union rather than a nullable result, because a skill that
 * threw produced no output path, no metadata and no file list — a synthetic
 * `PackageSkillResult` for it would have to invent all three, and every
 * consumer reading `files.dependencies.length` would then report a file count
 * for a bundle that does not exist on disk.
 */
export type SkillPackageOutcome =
  | { status: 'built'; skillPath: string; result: PackageSkillResult }
  | { status: 'failed'; skillPath: string; error: Error };

/**
 * Package multiple skills with a shared ResourceRegistry.
 *
 * Creates one registry for the entire project (crawling all .md files once),
 * then packages each skill against the shared registry. This eliminates
 * redundant I/O when building multiple skills from the same project.
 *
 * **One skill's failure never discards the batch.** `packageSkill` reports most
 * problems by RETURNING a result whose `hasErrors` is set, which callers already
 * degrade gracefully on — but it also THROWS on structural packaging failures
 * (an absent or unreadable `files:` source). Letting that throw escape the loop
 * made the two failure paths behave in opposite ways through one contract:
 * measured on a 90-skill project, one such failure discarded 89 completed builds
 * and collapsed the whole report into a single string. Each iteration is
 * therefore contained and reported as a `failed` outcome instead.
 *
 * A filename collision is NOT one of the throwing paths — it is a returned
 * `FILENAME_COLLISION` finding. Do not reach for a collision as the fixture when
 * testing this containment: the loop completes normally either way, so such a
 * test passes whether or not the containment exists.
 *
 * The registry build is deliberately OUTSIDE the containment: it is the run's
 * shared prerequisite, so its failure really does doom every skill and must
 * still propagate. Only per-skill work is contained.
 *
 * @param skills - Array of skill build specifications
 * @param projectRoot - Absolute path to the project root directory
 * @param allowLedger - The RUN's allow-usage ledger. Required, not
 *   optional-with-a-default, for the same reason `runValidationFramework`'s is:
 *   this function loops, so it can never honestly conclude on its own that an
 *   allow entry matched nothing — an entry matched while building skill A is
 *   USED for the run. It is never drained here; the caller drains it once with
 *   `allowUnusedIssues()` after everything in the invocation has been seen
 *   (`vat build` also validates the SOURCE tree, whose matches count too).
 *   Containment does not change that: a skill that threw may still have matched
 *   allow entries before it threw, and those matches count for the run.
 * @returns One outcome per input spec, in input order
 *
 * @example
 * ```typescript
 * const specs: SkillBuildSpec[] = [
 *   { skillPath: '/project/skills/SKILL.md', options: { outputPath: '/out/skill-a' } },
 *   { skillPath: '/project/skills/SKILL2.md', options: { outputPath: '/out/skill-b' } },
 * ];
 * const ledger = createAllowUsageLedger();
 * const outcomes = await packageSkills(specs, '/project', ledger);
 * const runIssues = allowUnusedIssues(ledger);
 * ```
 */
export async function packageSkills(
  skills: SkillBuildSpec[],
  projectRoot: string,
  allowLedger: AllowUsageLedger,
): Promise<SkillPackageOutcome[]> {
  // 1. Create one registry for the entire project. Through the shared builder:
  // this used to call `fromCrawl` directly and omit the config, so skills built
  // here belonged to no collection while a skill built through the single-skill
  // fallback did.
  const registry = await createProjectRegistry(projectRoot);

  // 2. Package each skill against the shared registry
  const outcomes: SkillPackageOutcome[] = [];
  for (const { skillPath, options } of skills) {
    try {
      const result = await packageSkill(skillPath, { ...options, registry, allowLedger });
      outcomes.push({ status: 'built', skillPath, result });
    } catch (error) {
      // Not swallowed: the error is carried on the outcome so the caller reports
      // WHICH skill failed and why, and gates the run's exit code on it.
      outcomes.push({
        status: 'failed',
        skillPath,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return outcomes;
}

/**
 * Package a skill with all its dependencies
 *
 * This is the unified packaging logic used by all flows.
 * Works with any SKILL.md file, whether generated or handwritten.
 *
 * @param skillPath - Absolute path to SKILL.md file
 * @param options - Packaging options
 * @returns Package result with metadata and artifact paths
 *
 * @example
 * ```typescript
 * const result = await packageSkill(
 *   'vat-example-cat-agents/resources/skills/SKILL.md',
 *   { formats: ['directory', 'zip'] }
 * );
 * ```
 */
export async function packageSkill(
  skillPath: string,
  options: PackageSkillOptions = {}
): Promise<PackageSkillResult> {
  const {
    formats = ['directory'],
    rewriteLinks = true,
    resourceNaming = 'basename',
    stripPrefix,
    target = DEFAULT_PACKAGING_TARGET,
  } = options;

  // 1. Parse SKILL.md frontmatter and links
  const parseResult = await parseMarkdown(skillPath);
  const skillMetadata = extractSkillMetadata(parseResult, skillPath);

  // 2. Find project boundary (config root -> git root -> skill dir).
  // Library callers fall back to the skill directory when canonical
  // findProjectRoot returns null. The CLI command boundary is responsible
  // for any user-facing warning about missing project roots.
  //
  // COORDINATE-SYSTEM ASSUMPTION, not an enforced invariant. This root is the base
  // every path this call REPORTS is stated in — `namingBasePath` at step 8, and the
  // `projectRoot` handed to `walkerExclusionsToIssues` / `testInputLinkIssues` /
  // `deferredAssetsToIssues` at step 13b. It is derived HERE, per skill, from the
  // skill's own path. It is NOT the `projectRoot` argument `packageSkills` was called
  // with (that one is used only for `createProjectRegistry`), and it is not the `cwd`
  // that `vat skills build` treats as the root of the document it emits.
  //
  // UNVERIFIED that these can actually diverge: in every path exercised so far the two
  // have coincided (`vat skills build` passes its `cwd`, and the skills it discovers
  // live under it), and no run has been observed where they differ. Nothing enforces
  // the equality, though — a caller packaging a skill from outside its own project
  // root would get issue locations in one coordinate system and a report header in
  // another, with no error anywhere.
  const projectRoot = findProjectRoot(dirname(skillPath)) ?? dirname(skillPath);
  const skillRoot = dirname(skillPath);

  // 3. Get or create the resource registry.
  // The fallback crawls and parses EVERY markdown file in the project, so any
  // caller packaging more than one skill must build the registry once itself
  // (see createProjectRegistry) and pass it — otherwise the whole-project scan
  // is paid once PER SKILL.
  const registry = options.registry ?? await createProjectRegistry(projectRoot);

  // 3b. Load per-collection frontmatter schemas (Gap 3: packager rewrites frontmatter URI-refs
  // against the same schemas the validator uses, with body parity).
  const collectionSchemas = await loadCollectionSchemas(registry.config, projectRoot);

  // 4. Walk the link graph using registry data
  const linkFollowDepth = options.linkFollowDepth ?? 2;
  const excludeConfig = options.excludeReferencesFromBundle;
  const excludeNavigationFiles = options.excludeNavigationFiles ?? true;
  const maxDepth = linkFollowDepth === 'full' ? Infinity : linkFollowDepth;

  // Find the skill resource in the registry
  const skillResource = registry.getResource(safePath.resolve(skillPath));
  const skillResourceId = skillResource?.id ?? '';

  const testInputDirs = options.testInputDirs ?? [];
  // Declaring a path under `test.evals` IS the instruction not to package it, so a
  // `files:` entry pointing into test input is dropped here rather than copied and
  // then complained about. The adopter never has to edit config to get the right
  // artifact; the dropped entries are reported below as warnings.
  const { kept: filesConfig, dropped: droppedTestInputFiles } = partitionTestInputFileEntries(
    options.files ?? [],
    projectRoot,
    testInputDirs,
  );
  const deferredArtifacts = DeferredArtifacts.from([{ files: filesConfig, skillDir: skillRoot }], projectRoot);

  const packagerWalkOptions: Parameters<typeof walkLinkGraph>[2] = {
    maxDepth,
    // Declared test input is dropped from the bundle before anything else decides
    // to include it — a link into the eval suite is not a packaging decision the
    // author gets to make (see test-input.ts).
    excludeRules: [...(excludeConfig?.rules ?? []), ...testInputExcludeRules(testInputDirs, projectRoot)],
    projectRoot,
    skillRootPath: safePath.resolve(skillPath),
    excludeNavigationFiles,
    deferredArtifacts,
  };
  if (options.gitTracker !== undefined) {
    packagerWalkOptions.gitTracker = options.gitTracker;
  }
  const { bundledResources, bundledAssets, excludedReferences, deferredAssets } = walkLinkGraph(
    skillResourceId,
    registry as WalkableRegistry,
    packagerWalkOptions,
  );

  // Register non-markdown bundled assets in the source registry so link rewriting
  // can resolve them (resolvedId must be set on links pointing to YAML, JSON, etc.).
  // For any asset whose ID collides with a paired markdown file (e.g. config.yaml +
  // config.md both produce id `resources-config`), we set a synthetic resolvedId on
  // links pointing to it so link rewriting still works.
  const collidedAssets = await registerBundledAssets(registry, bundledAssets);
  resolveCollidedAssetLinks(
    collectResourcesWithLinks(bundledResources, skillResource),
    collidedAssets,
  );

  // Combine bundled file paths: markdown resources + non-markdown assets
  const bundledFiles = [
    ...bundledResources.map(r => r.filePath),
    ...bundledAssets,
  ];

  // 5. Calculate common ancestor of all files (for proper relative path calculation)
  const allFiles = [skillPath, ...bundledFiles];
  const effectiveBasePath = findCommonAncestor(allFiles);

  // 6. Determine output path
  const outputPath = options.outputPath ??
    getDefaultSkillOutputPath(skillPath, skillMetadata.name);

  // 7. Clean stale output (skip when source SKILL.md lives inside the output, e.g. builder flow)
  const resolvedOutput = safePath.resolve(outputPath);
  const sourceInOutput = safePath.resolve(skillPath).startsWith(resolvedOutput + '/');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- outputPath is validated
  if (!sourceInOutput && existsSync(resolvedOutput)) {
    await rm(resolvedOutput, { recursive: true });
  }

  // 8. Build path map for file copying and link rewriting
  const namingBasePath = projectRoot;
  const pathMapSkill = { path: skillPath, name: skillMetadata.name };
  const pathMap = buildPathMap(
    pathMapSkill,
    bundledFiles, outputPath, resourceNaming, namingBasePath, stripPrefix, target,
  );

  // 8b. Apply files config to the path map: single-file entries by name, and glob
  // entries by re-pointing the link-bundled files they claim at the declared dest.
  applyFilesEntriesToPathMap(
    filesConfig, projectRoot, outputPath, pathMap, skillMetadata.name, bundledFiles,
  );

  // 8c. Collisions are judged on the FINAL destination map, so a `files:` remap is
  // a real remedy and a `files:`-created collision is still caught. See
  // detectDestinationCollisions for why this cannot run inside buildPathMap.
  const collisionIssues = detectDestinationCollisions(
    pathMapSkill, pathMap, outputPath, resourceNaming, namingBasePath,
  );

  // 9. Build "to" registry for link rewriting (maps same resource IDs to output paths)
  const outputResources = bundledResources.map(resource => ({
    ...resource,
    filePath: pathMap.get(toForwardSlash(resource.filePath)) ?? resource.filePath,
  }));
  // Include the skill resource itself in the "to" registry
  if (skillResource) {
    outputResources.push({
      ...skillResource,
      filePath: safePath.join(outputPath, 'SKILL.md'),
    });
  }
  // Add non-markdown bundled files (assets) to output registry so link rewriting resolves them
  addBundledAssetsToOutputRegistry(outputResources, bundledAssets, pathMap, registry, collidedAssets);
  // Register files: deferred-dest links so the build preserves/rewrites them (mirrors
  // the collided-asset handling). Stamps resolvedId on dest links and adds a synthetic
  // output resource so the rewriter renders [text](dest) instead of stripping to ().
  outputResources.push(
    ...registerDeferredDestLinks(
      filesConfig,
      collectResourcesWithLinks(bundledResources, skillResource),
      skillPath,
      outputPath,
      outputResources,
    ),
  );
  // Include excluded resources (with source paths) for pattern-based rule matching
  for (const excl of excludedReferences) {
    if (excl.excludeReason === 'directory-target' || excl.excludeReason === 'outside-project') {
      continue;
    }
    const exclResource = (registry as WalkableRegistry).getResource(safePath.resolve(excl.path));
    if (exclResource && !outputResources.some(r => r.id === exclResource.id)) {
      outputResources.push(exclResource);
    }
  }
  const outputRegistry = ResourceRegistry.fromResources(outputPath, outputResources);

  // 10. Build excluded resource IDs for rule matching.
  // Excluded IDs should NOT include resources that are already bundled.
  // A resource can appear in both bundledResources (via short path) and
  // excludedReferences (via long path that exceeds depth). The bundled
  // status wins — links to it should be rewritten, not stripped.
  const bundledResourceIds = new Set(bundledResources.map(r => r.id));
  const excludedIds = [...new Set(
    excludedReferences
      .filter(r => r.excludeReason !== 'directory-target' && r.excludeReason !== 'outside-project')
      .map(r => {
        const res = (registry as WalkableRegistry).getResource(safePath.resolve(r.path));
        return res?.id;
      })
      .filter((id): id is string => id !== undefined && !bundledResourceIds.has(id)),
  )];

  // 11. Build unified rewrite rules (bundled + excluded, all via transformContent)
  const rewriteRules = buildRewriteRules(
    excludedIds,
    excludeConfig?.rules ?? [],
    excludeConfig?.defaultTemplate,
  );

  // 12. Copy and rewrite files
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- outputPath is validated
  await mkdir(outputPath, { recursive: true });

  await copyAndRewriteFiles(skillPath, bundledFiles, {
    pathMap,
    rewriteLinks,
    fromRegistry: registry as WalkableRegistry,
    toRegistry: outputRegistry,
    rewriteRules,
    templateContext: { skill: { name: skillMetadata.name } },
    collectionSchemas,
    projectRoot,
    warn: (message) => process.stderr.write(`warning: ${message}\n`),
  });

  // 12b. Copy files config entries that were not auto-discovered via link traversal.
  // Keep the dests it reports: they are what makes the orphan check below able to
  // tell "the author forgot to document this" from "VAT put this here because the
  // config said to." Discarding them makes the build fail on its own payload.
  const appliedFiles = await applyFilesConfig({
    filesConfig, projectRoot, skillOutputDir: outputPath, bundledFiles,
  });
  const filesConfigDests = appliedFiles.dests;
  // Dests a glob matched and the never-package list refused. Two consumers, and
  // both are load-bearing: the broken-link check below needs them to tell a link
  // broken by policy from a link broken by the rewriter, and the finding channel
  // needs them or the structured report says `warnings: 0` about a build that
  // silently shipped less than the config asked for.
  const droppedGlobDests = appliedFiles.dropped.map((drop) => drop.dest);

  // 13. Post-build integrity check: no SKILL.md in subdirectories
  // A SKILL.md is a skill definition marker — it must only exist at the root.
  // If another skill's SKILL.md was bundled as a resource, it creates duplicate
  // skill definitions that break marketplace sync and confuse skill consumers.
  await validateNoNestedSkillMd(outputPath, skillMetadata.name);

  // 13b. Post-build integrity checks (unreferenced files, broken packaged links).
  //
  // Runs BEFORE generatePackageArtifacts so the synthetic package.json from
  // createNpmPackage isn't flagged as unreferenced.
  //
  // Walker-exclusion issues (depth drops, missing targets, outside-project, etc.)
  // are combined with post-build checks and run through the validation framework.
  const rawPostBuildIssues = [
    // Found back at step 8, reported here: the path map is decided before any
    // file is written, but a collision is a packaging FINDING and rides the same
    // channel as every other one rather than aborting the run from inside a
    // helper.
    ...collisionIssues,
    ...await checkUnreferencedFiles(outputPath, filesConfigDests),
    ...await checkBrokenPackagedLinks(outputPath, droppedGlobDests),
    // A receipt for every file a glob matched and the never-package list refused.
    // Reported as an issue, not written to stderr: a file vanishing from a bundle
    // has to be visible in `issueCounts`, or CI reads a clean report for a build
    // that quietly shipped less than the config declared.
    // Anchored at the PROJECT root, not `outputPath` like its neighbours here: a
    // dropped file is a source file that never reached the output, so the only
    // path a reader can open is its source path.
    ...droppedGlobMatchesToIssues(appliedFiles.dropped, projectRoot),
    // Presence-side backstop for agent-instruction files. The walker excludes
    // them from link-following, but a `files:` glob can still copy one in, and
    // a file that arrives without a link is invisible to the link lane.
    //
    // Explicitly-declared dests are exempt (§8.2 precedence): the build KNOWS the
    // config here, and an explicit `files:` entry is an instruction to ship that
    // exact file. Reporting it fired this warning on the very config the guide
    // prescribes as the escape hatch, with a remedy ("remove the file") that says
    // to undo what the author was told to write.
    ...detectPackagedAgentInstructionFiles(
      outputPath,
      outputPath,
      explicitFilesConfigDests(filesConfig),
    ),
    // A receipt for each `files:` entry that was dropped for pointing into declared
    // test input — the build already produced the right artifact; this just says so.
    ...testInputFileEntryIssues(droppedTestInputFiles),
    // Backstop: if declared test input reached the output despite both exclusions,
    // say so rather than shipping an answer key silently.
    ...checkPackagedTestInput({ pathMap, outputPath, testInputDirs }),
  ];
  const rawLinkIssues = [
    ...walkerExclusionsToIssues(excludedReferences, projectRoot),
    // The link half of the same receipt: a link INTO declared test input is dropped
    // and rewritten away, which the generic exclusion channel reports as nothing
    // (a pattern match is author-declared intent; this exclusion is VAT's).
    ...testInputLinkIssues(excludedReferences, testInputDirs, projectRoot),
    ...deferredAssetsToIssues(deferredAssets, projectRoot),
  ];

  // ONE ledger for BOTH lanes below. `options.validation.allow` governs the
  // build-receipt lane AND the built-SKILL.md lane, but the two see disjoint
  // issue populations — so a lane that drains its own ledger calls "unused" an
  // entry the OTHER lane matched. (Measured before the fix: an entry that
  // suppressed a real LINK_MISSING_TARGET error still emitted ALLOW_UNUSED from
  // the built-output lane, and a genuinely dead entry was reported twice.) Same
  // defect, same fix as the validate lane — see
  // `SkillValidationSharedContext.allowLedger`.
  //
  // Whose run it is comes from the caller. Given a ledger, this call is one unit
  // of a larger run (a batch, and/or a source-tree validation pass that matches
  // entries this build's two lanes structurally cannot) and must NOT drain —
  // draining here is what reported a package-scoped entry matched while building
  // skill A as unused while building skill B. Given none, the caller has claimed
  // this call IS the run, so the drain below is honest.
  const ownsRun = options.allowLedger === undefined;
  const buildRunLedger = options.allowLedger ?? createAllowUsageLedger();

  const framework = runValidationFramework(
    [...rawLinkIssues, ...rawPostBuildIssues],
    options.validation ?? {},
    buildRunLedger,
  );

  // 13c. Run full validation suite on built output
  const postBuildValidation = await runPostBuildValidation(
    outputPath,
    options.validation,
    buildRunLedger,
  );

  // 14. Generate distribution artifacts
  const artifacts = await generatePackageArtifacts(
    outputPath,
    skillMetadata,
    formats,
    target
  );

  // Get relative paths for result
  const relativeLinkedFiles = bundledFiles.map(f =>
    safePath.relative(effectiveBasePath, f)
  );

  // Build result
  return assemblePackageResult({
    outputPath,
    skillMetadata,
    relativeLinkedFiles,
    artifacts,
    postBuildValidation,
    // Drain point — but only when this call owns the run. Both lanes have now
    // contributed; whether anything ELSE still will is the caller's claim.
    framework: ownsRun ? withRunAllowUnused(framework, buildRunLedger) : framework,
    excludedReferences,
    skillRoot,
  });
}

/**
 * Fold the build run's ALLOW_UNUSED verdict into the build-issue lane.
 *
 * ALLOW_UNUSED belongs to the RUN, not to whichever lane happened to be looking
 * when an entry went unmatched — so it is drained once, here, and reported on
 * the single channel (`postBuildIssues`) rather than on both.
 */
function withRunAllowUnused(framework: FrameworkResult, ledger: AllowUsageLedger): FrameworkResult {
  const unused = allowUnusedIssues(ledger);
  if (unused.length === 0) return framework;
  const emitted = [...framework.emitted, ...unused];
  return { ...framework, emitted, hasErrors: emitted.some(i => i.severity === 'error') };
}

/**
 * Run full validation suite against built output (context = 'built').
 * Source-only codes are automatically filtered out by validateSkillForPackaging.
 *
 * `allowLedger` is required, not optional: this lane is one half of a build, so
 * it must never conclude on its own that an allow entry matched nothing.
 */
async function runPostBuildValidation(
  outputPath: string,
  validation: ValidationConfig | undefined,
  allowLedger: AllowUsageLedger,
): Promise<PackagingValidationResult> {
  const builtSkillPath = safePath.join(outputPath, 'SKILL.md');
  return validateSkillForPackaging(
    builtSkillPath,
    validation ? { validation } : undefined,
    'built',
    { allowLedger },
  );
}

/** Input for assemblePackageResult — avoids a long parameter list. */
interface AssembleResultInput {
  outputPath: string;
  skillMetadata: SkillMetadata;
  relativeLinkedFiles: string[];
  artifacts: Record<string, string>;
  postBuildValidation: PackagingValidationResult;
  framework: FrameworkResult;
  excludedReferences: Array<{ path: string }>;
  skillRoot: string;
}

/**
 * Assemble the final PackageSkillResult from intermediate data.
 * Extracted to keep packageSkill() within the cognitive-complexity budget.
 */
function assemblePackageResult(input: AssembleResultInput): PackageSkillResult {
  const result: PackageSkillResult = {
    outputPath: input.outputPath,
    skill: input.skillMetadata,
    files: {
      root: 'SKILL.md',
      dependencies: input.relativeLinkedFiles,
    },
    artifacts: input.artifacts,
    postBuildValidation: input.postBuildValidation,
    hasErrors: input.framework.hasErrors || input.postBuildValidation.status === 'error',
  };

  if (input.framework.emitted.length > 0) {
    result.postBuildIssues = input.framework.emitted;
  }

  if (input.excludedReferences.length > 0) {
    const uniqueExcludedPaths = [...new Set(
      input.excludedReferences.map(r => safePath.relative(input.skillRoot, r.path))
    )];
    result.excludedReferences = uniqueExcludedPaths;
  }

  return result;
}

// ============================================================================
// Registry Creation
// ============================================================================

/**
 * Build THE project registry: every markdown file under `projectRoot`, parsed,
 * with links resolved and the project config attached.
 *
 * This is the one builder for "the registry a packaging run works against", and
 * every lane that packages skills must call it EXACTLY ONCE per run and pass the
 * result into each {@link packageSkill}. It crawls and parses the entire project
 * — on a large monorepo that is thousands of files and tens of seconds — so a
 * caller that lets `packageSkill` fall back to it per skill turns a fixed
 * project-sized cost into a per-skill one.
 *
 * It also carries the config, which decides collection membership: the packager
 * rewrites frontmatter URI-references per collection schema, mirroring the
 * validator. A registry built without config silently belongs to no collection,
 * so a lane that built its own config-less registry rewrote frontmatter
 * differently from the lane that used this one — which is why there is now only
 * one builder rather than two that happened to differ in one argument.
 */
export async function createProjectRegistry(projectRoot: string): Promise<ResourceRegistry> {
  const config = await loadConfig(projectRoot);
  const registry = await ResourceRegistry.fromCrawl(
    {
      baseDir: projectRoot,
      include: ['**/*.md'],
    },
    config === undefined ? undefined : { config },
  );
  registry.resolveLinks();
  return registry;
}

/**
 * Load frontmatter schemas for all configured collections, keyed by collection ID.
 *
 * Mirrors ResourceRegistry.validateAgainstCollectionSchema's loading flow so
 * the packager rewrites frontmatter URI-refs against the same schemas the
 * validator uses. Collections without a frontmatterSchema configured are
 * absent from the map. Schema file read/parse failures are silently skipped
 * — the validator will surface those errors elsewhere; the packager just
 * won't rewrite the un-routed collection's frontmatter.
 */
async function loadCollectionSchemas(
  config: ProjectConfig | undefined,
  baseDir: string,
): Promise<Map<string, object>> {
  const schemas = new Map<string, object>();
  const collections = config?.resources?.collections;
  if (!collections) return schemas;
  for (const [collectionId, collectionConfig] of Object.entries(collections)) {
    const schemaPath = collectionConfig.validation?.frontmatterSchema;
    if (schemaPath === undefined) continue;
    try {
      const resolvedPath = resolveAssetReference(schemaPath, baseDir);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- schema path from validated config
      const content = await readFile(resolvedPath, 'utf-8');
      schemas.set(collectionId, JSON.parse(content) as object);
    } catch {
      // Schema unavailable — validator will report; packager skips rewrite.
    }
  }
  return schemas;
}

/**
 * Generate a synthetic resource ID for a non-markdown asset that collides with an
 * existing markdown resource. Uses the absolute asset path prefixed with `asset::`
 * to guarantee uniqueness — this id is used only for skill-packager internal
 * lookups (output registry + link rewriting), not for user-facing output.
 */
export function synthesizeAssetId(assetPath: string): string {
  return `asset::${toForwardSlash(safePath.resolve(assetPath))}`;
}

/**
 * Collect all resources whose links may need collided-asset resolution:
 * bundled markdown resources + the skill resource itself (if indexed).
 * Deduplicates in case the skill is also in bundledResources.
 */
function collectResourcesWithLinks(
  bundledResources: ResourceMetadata[],
  skillResource: ResourceMetadata | undefined,
): ResourceMetadata[] {
  if (skillResource === undefined || bundledResources.includes(skillResource)) {
    return bundledResources;
  }
  return [...bundledResources, skillResource];
}

/**
 * Register non-markdown bundled assets in the registry so their links get resolvedId.
 *
 * The registry only crawls *.md files by default. Non-markdown files (YAML, JSON, etc.)
 * discovered via link walking are not indexed, so links pointing to them won't have
 * `resolvedId` set. Link rewriting depends on `resolvedId` to look up the target resource
 * and compute the output `relativePath`. Without this, non-markdown links get stripped
 * to empty `()` parentheses.
 *
 * Collision handling: if an asset's generated ID clashes with an existing markdown
 * resource (e.g. paired `config.yaml` + `config.md` both produce id `resources-config`),
 * `addResource` throws. We catch this, skip source-registry indexing for the asset,
 * and return it so the caller can synthesize a unique ID for link rewriting.
 *
 * @returns Paths of assets that could not be added to the source registry due to
 *   duplicate-ID collisions. Caller must wire these up manually.
 */
async function registerBundledAssets(
  registry: ResourceRegistry,
  bundledAssets: string[],
): Promise<string[]> {
  const collidedAssets: string[] = [];
  if (bundledAssets.length === 0) {
    return collidedAssets;
  }
  for (const assetPath of bundledAssets) {
    try {
      await registry.addResource(assetPath);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Duplicate resource ID')) {
        collidedAssets.push(assetPath);
      } else {
        throw error;
      }
    }
  }
  registry.resolveLinks();
  return collidedAssets;
}

/**
 * Manually set `resolvedId` on links pointing to collided assets.
 *
 * When a non-markdown asset collides with a markdown file (same stem, different
 * extension), it can't be indexed in the source registry. `resolveLinks()` won't
 * set `resolvedId` on links to these assets. We walk every bundled markdown
 * resource's links and assign a synthetic `resolvedId` to links whose target
 * path matches a collided asset.
 */
function resolveCollidedAssetLinks(
  resources: ResourceMetadata[],
  collidedAssets: string[],
): void {
  if (collidedAssets.length === 0) {
    return;
  }
  const collidedByPath = new Map<string, string>(
    collidedAssets.map(p => [safePath.resolve(p), synthesizeAssetId(p)]),
  );
  for (const resource of resources) {
    for (const link of resource.links) {
      if (link.type !== 'local_file' || link.resolvedId !== undefined) {
        continue;
      }
      const [hrefPath] = link.href.split('#');
      if (hrefPath === undefined) continue;
      const targetPath = safePath.resolve(dirname(resource.filePath), hrefPath);
      const syntheticId = collidedByPath.get(targetPath);
      if (syntheticId !== undefined) {
        link.resolvedId = syntheticId;
      }
    }
  }
}

/**
 * Add non-markdown bundled assets to the output registry so link rewriting can resolve them.
 *
 * Each asset's output path comes from `pathMap`. The source registry (populated by
 * `registerBundledAssets`) supplies the resource record for non-colliding assets.
 * For collided assets (ID clashes with a paired markdown file), we synthesize a
 * minimal resource record using the same synthetic ID set on links by
 * `resolveCollidedAssetLinks`. Assets already present in `outputResources` are skipped.
 */
function addBundledAssetsToOutputRegistry(
  outputResources: ResourceMetadata[],
  bundledAssets: string[],
  pathMap: Map<string, string>,
  registry: WalkableRegistry,
  collidedAssets: string[],
): void {
  const collidedSet = new Set(collidedAssets.map(p => toForwardSlash(p)));
  for (const assetPath of bundledAssets) {
    const outputFilePath = pathMap.get(toForwardSlash(assetPath));
    if (!outputFilePath) continue;
    if (outputResources.some(r => toForwardSlash(r.filePath) === toForwardSlash(outputFilePath))) {
      continue;
    }
    const sourceResource = registry.getResource(safePath.resolve(assetPath));
    if (sourceResource) {
      outputResources.push({
        ...sourceResource,
        filePath: outputFilePath,
      });
    } else if (collidedSet.has(toForwardSlash(assetPath))) {
      // Asset collided with a paired markdown file and isn't in the source registry.
      // Synthesize a minimal record — id matches what resolveCollidedAssetLinks set.
      outputResources.push(buildSyntheticAssetResource(assetPath, outputFilePath));
    }
  }
}

/**
 * Build a minimal ResourceMetadata record for a non-markdown asset that couldn't
 * be added to the source registry due to an ID collision with a paired markdown file.
 */
function buildSyntheticAssetResource(
  assetPath: string,
  outputFilePath: string,
): ResourceMetadata {
  return {
    id: synthesizeAssetId(assetPath),
    filePath: outputFilePath,
    links: [],
    headings: [],
    sizeBytes: 0,
    estimatedTokenCount: 0,
    modifiedAt: new Date(0),
    // Synthetic asset; no real content hash. Use all-zeros to satisfy the SHA256 brand.
    checksum: '0'.repeat(64) as ResourceMetadata['checksum'],
  };
}

/**
 * Re-point every LINK-BUNDLED file a GLOB `files:` entry also claims at the dest
 * that entry declares.
 *
 * A glob's expansion is late-bound to copy time, so its matches used to be absent
 * from the path map entirely — and a match that link traversal ALSO discovered was
 * therefore parked at its type-derived location (`resources/GUIDE.md`) while
 * `applyFilesConfig` copied the same bytes to the declared dest
 * (`packs/alpha/GUIDE.md`). Two identical files shipped, the rewritten link pointed
 * at traversal's copy, the declared `dest:` was dead, and nothing said so — a size
 * regression for anyone shipping multi-megabyte artifacts, and a `dest:` that lies
 * whenever the same file is also referenced from prose.
 *
 * Only files already in `bundledFiles` are considered: this is not a second
 * expansion of the glob (that stays with {@link copyGlobEntry}), it is the path map
 * — the authority on where a file ends up — learning what the config already said.
 */
function applyGlobEntryToPathMap(
  entry: SkillFileEntry,
  projectRoot: string,
  outputPath: string,
  pathMap: Map<string, string>,
  bundledFiles: string[],
): void {
  for (const bundled of bundledFiles) {
    const dest = globEntryDest(entry, projectRoot, bundled);
    if (dest === undefined) continue;
    // joinUnderRoot mirrors the non-glob branch's zip-slip guard below.
    pathMap.set(toForwardSlash(bundled), safePath.joinUnderRoot(outputPath, dest));
  }
}

/**
 * Register `files:` config entries in the path map.
 *
 * Two passes, GLOBS FIRST, and the order is the precedence rule: an explicit entry
 * naming a file outranks a glob that merely caught it, exactly as it does on the
 * copy side (see `partitionNeverPackaged` — a glob is a net, not a declaration).
 * Applying globs second would let one silently overwrite the dest an author spelled
 * out, and the explicit entry's own copy is then skipped as "already bundled at its
 * dest" — so the declared file would never be written at all.
 *
 * Called from step 8b of packageSkill to keep the main function under the
 * cognitive-complexity limit.
 */
function applyFilesEntriesToPathMap(
  filesConfig: SkillFileEntry[],
  projectRoot: string,
  outputPath: string,
  pathMap: Map<string, string>,
  skillName: string,
  bundledFiles: string[],
): void {
  for (const fileEntry of filesConfig) {
    if (isGlob(fileEntry.source)) {
      applyGlobEntryToPathMap(fileEntry, projectRoot, outputPath, pathMap, bundledFiles);
    }
  }

  for (const fileEntry of filesConfig) {
    // A glob source contains magic, never exists as a literal path, and would
    // wrongly throw the existence check below; its dests were handled above.
    if (isGlob(fileEntry.source)) continue;

    const absoluteSource = safePath.resolve(safePath.join(projectRoot, fileEntry.source));
    // joinUnderRoot guards against a dest escaping the output dir (zip-slip class),
    // defense-in-depth beyond the schema refine on SkillFileEntry.dest.
    const absoluteDest = safePath.joinUnderRoot(outputPath, fileEntry.dest);

    // Validate source exists at build time
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- source path from validated config
    if (!existsSync(absoluteSource)) {
      throw new Error(
        `files entry for skill '${skillName}': source '${fileEntry.source}' does not exist.${buildArtifactHint(fileEntry.source)}`,
      );
    }

    // If this source was auto-discovered, override its destination; otherwise add it
    pathMap.set(toForwardSlash(absoluteSource), absoluteDest);
  }
}

/**
 * Register `files:` deferred-dest links so the build preserves and rewrites them.
 *
 * A deferred dest (e.g. `dist/bin/cli.mjs → scripts/cli.mjs`) does not exist at
 * source-walk time, so it is neither a bundled resource nor a bundled asset: its
 * link gets no `resolvedId` and the dest is absent from the output registry. The
 * bundled-link template then renders an empty `relativePath` and strips the href
 * to `()` — leaving the shipped artifact unreferenced (`PACKAGED_UNREFERENCED_FILE`).
 *
 * This mirrors the collided-asset handling: for each `files:` entry we synthesize
 * a stable id (`synthesizeAssetId(absDestTarget)`), stamp it as `resolvedId` on
 * any local_file link that resolves to the dest, and return a synthetic output
 * resource (`buildSyntheticAssetResource`) whose `filePath` is the dest's output
 * path so the output registry computes `relativePath = entry.dest`.
 *
 * For GLOB entries, the dest is a DIRECTORY. We scan each unresolved local_file
 * link across all resources; any link whose resolved target T falls under the dest
 * dir gets an individual synthetic resource stamped per-file (see registerGlobDestLinks).
 *
 * Scope: dest links only. A SKILL.md link to a deferred *source* path that is
 * copied to a different dest is an exotic case with ambiguous output mapping and
 * is intentionally left to its existing behavior.
 *
 * @returns Synthetic output resources to push into `outputResources` (deduped by
 *   filePath against the existing set) BEFORE the output registry is built.
 */
function registerDeferredDestLinks(
  filesConfig: SkillFileEntry[],
  resources: ResourceMetadata[],
  skillPath: string,
  outputPath: string,
  existingOutputResources: ResourceMetadata[],
): ResourceMetadata[] {
  const syntheticResources: ResourceMetadata[] = [];
  const skillDir = dirname(skillPath);
  for (const entry of filesConfig) {
    if (isGlob(entry.source)) {
      // Glob entry: dest is a directory. Synthesize per-linked-file.
      registerGlobDestLinks(entry, resources, skillDir, outputPath, existingOutputResources, syntheticResources);
    } else {
      // Single-file entry: UNCHANGED — exact dest match (resolved against skillDir).
      const absDestTarget = safePath.resolve(skillDir, entry.dest);
      // joinUnderRoot keeps the synthesized output path inside the skill output dir.
      const absDestOutput = safePath.joinUnderRoot(outputPath, entry.dest);
      const id = synthesizeAssetId(absDestTarget);

      if (!stampDeferredDestResolvedId(resources, absDestTarget, id)) continue;

      // Dedup: skip if an output resource already targets this dest output path.
      const alreadyPresent =
        existingOutputResources.some(r => toForwardSlash(r.filePath) === toForwardSlash(absDestOutput)) ||
        syntheticResources.some(r => toForwardSlash(r.filePath) === toForwardSlash(absDestOutput));
      if (alreadyPresent) continue;

      // buildSyntheticAssetResource derives the id via synthesizeAssetId(absDestTarget),
      // matching the resolvedId stamped above.
      syntheticResources.push(buildSyntheticAssetResource(absDestTarget, absDestOutput));
    }
  }
  return syntheticResources;
}

/**
 * For a GLOB files entry whose dest is a DIRECTORY, walk every unresolved
 * local_file link across `resources`. If a link's resolved target T falls under
 * the entry's dest dir, synthesize a per-file entry: stamp `resolvedId` on the
 * link and push a synthetic output resource so the output registry can compute
 * `relativePath = skillDir-relative(T)`.
 *
 * Prefix test (T is "under" absDestDir):
 *   T === absDestDir  OR  toForwardSlash(T).startsWith(toForwardSlash(absDestDir) + '/')
 */
interface GlobDestLinkContext {
  absDestDir: string;
  absDestDirFwd: string;
  skillDir: string;
  outputPath: string;
  existingOutputResources: ResourceMetadata[];
  syntheticResources: ResourceMetadata[];
}

function registerGlobDestLinks(
  entry: SkillFileEntry,
  resources: ResourceMetadata[],
  skillDir: string,
  outputPath: string,
  existingOutputResources: ResourceMetadata[],
  syntheticResources: ResourceMetadata[],
): void {
  const absDestDir = safePath.resolve(skillDir, entry.dest);
  const ctx: GlobDestLinkContext = {
    absDestDir,
    absDestDirFwd: toForwardSlash(absDestDir),
    skillDir,
    outputPath,
    existingOutputResources,
    syntheticResources,
  };

  for (const resource of resources) {
    for (const link of resource.links) {
      synthesizeGlobLinkResource(link, resource.filePath, ctx);
    }
  }
}

/**
 * Attempt to synthesize a glob-dest output resource for a single link.
 *
 * Stamps `link.resolvedId` and pushes a synthetic resource if the link target
 * falls under the glob entry's dest dir and has not been synthesized yet.
 * No-ops for already-resolved links, non-local-file links, and links outside
 * the dest dir.
 */
function synthesizeGlobLinkResource(
  link: ResourceMetadata['links'][number],
  resourceFilePath: string,
  ctx: GlobDestLinkContext,
): void {
  if (link.type !== 'local_file' || link.resolvedId !== undefined) return;

  const [hrefPath] = link.href.split('#');
  if (hrefPath === undefined) return;

  const T = safePath.resolve(dirname(resourceFilePath), hrefPath);
  const Tfwd = toForwardSlash(T);

  // Prefix test: T must be equal to or under absDestDir
  if (T !== ctx.absDestDir && !Tfwd.startsWith(ctx.absDestDirFwd + '/')) return;

  // Stamp resolvedId per-linked-file
  link.resolvedId = synthesizeAssetId(T);

  // absDestOutput: preserve T's path relative to skillDir under outputPath.
  // joinUnderRoot keeps it inside the output dir (T is verified under absDestDir,
  // itself under skillDir once the dest schema rejects '..'/absolute).
  const absDestOutput = safePath.joinUnderRoot(ctx.outputPath, safePath.relative(ctx.skillDir, T));

  // Dedup against existing + already-synthesized
  const alreadyPresent =
    ctx.existingOutputResources.some(r => toForwardSlash(r.filePath) === toForwardSlash(absDestOutput)) ||
    ctx.syntheticResources.some(r => toForwardSlash(r.filePath) === toForwardSlash(absDestOutput));
  if (!alreadyPresent) {
    ctx.syntheticResources.push(buildSyntheticAssetResource(T, absDestOutput));
  }
}

/**
 * Stamp `resolvedId` on every unresolved local_file link that resolves to the
 * deferred dest target. Mirrors the link-walk in `resolveCollidedAssetLinks`.
 *
 * @returns true if at least one link was stamped (the dest is referenced).
 */
function stampDeferredDestResolvedId(
  resources: ResourceMetadata[],
  absDestTarget: string,
  id: string,
): boolean {
  let linked = false;
  for (const resource of resources) {
    for (const link of resource.links) {
      if (link.type !== 'local_file' || link.resolvedId !== undefined) {
        continue;
      }
      const [hrefPath] = link.href.split('#');
      if (hrefPath === undefined) continue;
      if (safePath.resolve(dirname(resource.filePath), hrefPath) === absDestTarget) {
        link.resolvedId = id;
        linked = true;
      }
    }
  }
  return linked;
}

// ============================================================================
// Path Map Building
// ============================================================================

/**
 * Determine the resource subdirectory for a file.
 *
 * For claude-web target: uses the existing references directory.
 * For claude-code target: uses content-type routing based on file extension.
 */
export function getResourceSubdirForFile(filePath: string, target: PackagingTarget): string {
  if (target === 'claude-web') {
    return CLAUDE_WEB_REFERENCES_SUBDIR;
  }
  return getTargetSubdir(filePath);
}

/**
 * The skill a path map is being built for: where it lives, and what it is called.
 *
 * Both, in one parameter, because the two answer different questions and the
 * function needs both: the PATH is the map's key (an identity, kept absolute),
 * while the NAME is what a failure REPORTS (an identifier, safe to publish —
 * `vat skills build` publishes packaging findings verbatim on stdout, where an
 * absolute path would name the machine that ran the build).
 */
interface PathMapSkill {
  path: string;
  name: string;
}

/**
 * The FILENAME_COLLISION finding for one pair of sources that package to one dest.
 *
 * Naming the skill is the whole point of the first line: neither colliding file
 * need be referenced by SKILL.md directly (both are commonly reached by deep
 * link traversal), so without it the only way to find the owner in a large
 * batch is to bisect it one skill at a time.
 *
 * By NAME, not by absolute path: this message is published verbatim in
 * `vat skills build`'s stdout payload, the name is what that payload's per-skill
 * rows already key on, and a `/Users/<someone>/…` prefix answers no question the
 * reader has while naming the machine the build ran on. The colliding files
 * follow the same rule — stated in the project's coordinates, like every other
 * "where" this package renders (`issueLocation`).
 *
 * `location` is the SECOND file: of the two, it is the one whose packaging the
 * first pre-empted, so it is the one an author renames. The remedy that is not
 * a rename (switch `resourceNaming`) comes from the registry `fix`.
 */
function filenameCollisionIssue(
  skill: PathMapSkill,
  existingSource: string,
  linkedFile: string,
  targetRelPath: string,
  resourceNaming: ResourceNamingStrategy,
  namingBasePath: string,
): ValidationIssue {
  const location = issueLocation(linkedFile, namingBasePath);
  return materializeIssue('FILENAME_COLLISION', {
    location,
    message:
      `Filename collision detected when packaging skill: ${skill.name} — ` +
      `File 1: ${issueLocation(existingSource, namingBasePath)}, ` +
      `File 2: ${location}; both would be packaged as ${targetRelPath} ` +
      `(current resourceNaming strategy: ${resourceNaming})`,
  });
}

/**
 * Build a map of source paths (forward-slash normalized) to output paths, plus
 * a FILENAME_COLLISION finding for every pair of sources that land on one dest.
 *
 * A collision is REPORTED, not thrown. It used to throw a raw `Error`, which
 * escaped the contract every other packaging finding honours — the caller got a
 * bare string instead of a coded, located, fixable `ValidationIssue`, and the
 * batch lane had to special-case it. The build still fails: the finding's
 * registry severity is `error`, so it flips `hasErrors`.
 *
 * The colliding source keeps its path-map entry rather than being dropped. The
 * build is failing either way, and keeping it means the link rewriter still
 * resolves both links to a file that exists in the output — dropping it would
 * add a second, derived PACKAGED_BROKEN_LINK on top of the real finding and
 * point the surviving link at an unrewritable source path.
 *
 * @param namingBasePath - The project root. Resource names are generated
 *   relative to it AND every path this function REPORTS is stated in its
 *   coordinates, so no message leaves here in machine-specific terms.
 */
function buildPathMap(
  skill: PathMapSkill,
  bundledFiles: string[],
  outputPath: string,
  resourceNaming: ResourceNamingStrategy,
  namingBasePath: string,
  stripPrefix?: string,
  target: PackagingTarget = DEFAULT_PACKAGING_TARGET,
): Map<string, string> {
  const pathMap = new Map<string, string>();
  pathMap.set(toForwardSlash(skill.path), safePath.join(outputPath, 'SKILL.md'));

  for (const linkedFile of bundledFiles) {
    const targetRelPath = generateTargetPath(
      linkedFile,
      namingBasePath,
      resourceNaming,
      stripPrefix
    );
    const fileSubdir = getResourceSubdirForFile(linkedFile, target);
    pathMap.set(toForwardSlash(linkedFile), safePath.join(outputPath, fileSubdir, targetRelPath));
  }

  return pathMap;
}

/**
 * Report a FILENAME_COLLISION for every destination claimed by more than one source.
 *
 * MUST run against the FINAL destination map — after `files:` single-file entries
 * have overridden the naming-strategy destinations. Detecting collisions while
 * building the map (where this logic used to live) answers the question one step
 * too early: `files:` is a legitimate remedy for a basename collision, and an
 * adopter who remapped both sides to distinct dests still had the build failed at
 * `error` severity for a collision that no longer physically occurred. It also
 * could not see the inverse — two `files:` entries pointing at ONE dest is a real
 * collision the naming-strategy map contains no trace of.
 *
 * Scope: glob `files:` entries expand later (`applyFilesConfig`) and so are not in
 * this map; their destinations are directories, which cannot collide this way.
 */
function detectDestinationCollisions(
  skill: PathMapSkill,
  pathMap: Map<string, string>,
  outputPath: string,
  resourceNaming: ResourceNamingStrategy,
  namingBasePath: string,
): ValidationIssue[] {
  const sourcesByDest = new Map<string, string[]>();
  for (const [source, dest] of pathMap) {
    const existing = sourcesByDest.get(dest);
    if (existing) existing.push(source);
    else sourcesByDest.set(dest, [source]);
  }

  const issues: ValidationIssue[] = [];
  for (const [dest, sources] of sourcesByDest) {
    // Map iteration is insertion-ordered, so sources[0] is the entry that "won"
    // the destination — the same File 1 / File 2 framing the message always used.
    const [winner, ...losers] = sources;
    if (winner === undefined || losers.length === 0) continue;
    const targetRelPath = toForwardSlash(safePath.relative(outputPath, dest));
    for (const loser of losers) {
      issues.push(filenameCollisionIssue(
        skill, winner, loser, targetRelPath, resourceNaming, namingBasePath,
      ));
    }
  }
  return issues;
}

// ============================================================================
// Rewrite Rules
// ============================================================================

/**
 * Build unified link rewrite rules for transformContent().
 *
 * Rules are ordered for first-match-wins semantics:
 * 1. Per-pattern excludes: local_file links matching specific patterns → custom template
 * 2. Bundled links: local_file links minus excluded IDs → rewrite to output path
 * 3. Catch-all excludes: remaining local_file links (depth-exceeded, navigation) → strip
 *
 * Per-pattern excludes run first so that terminal links to non-markdown assets
 * (YAML, JSON, images) match against the link's href via `matchesPattern`'s
 * href fallback — such links have no resolvedId and would otherwise be caught
 * by the bundled-link rule and rendered with an undefined `link.resource.*`.
 *
 * External, anchor, and email links match no rule and are left untouched.
 */
function buildRewriteRules(
  excludedIds: string[],
  excludeRules: Array<{ patterns: string[]; template?: string | undefined }>,
  defaultExcludeTemplate: string | undefined,
): LinkRewriteRule[] {
  const rules: LinkRewriteRule[] = [];
  const stripTemplate = defaultExcludeTemplate ?? DEFAULT_STRIP_TEMPLATE;
  // Both spellings of a local target. A link to a directory is `local_directory`
  // when the href ends in `/` and `local_file` when it does not; neither has a
  // packaged counterpart, and leaving the slash form out of every rule is what let
  // it survive rewrite verbatim and then fail the build as a broken packaged link.
  const LOCAL_TYPES = ['local_file', 'local_directory'] as const;

  // Rules 1+: Per-pattern exclude rules (if any)
  for (const rule of excludeRules) {
    rules.push({
      match: { type: [...LOCAL_TYPES], pattern: rule.patterns },
      template: rule.template ?? stripTemplate,
    });
  }

  // Rule N: Bundled links — match local targets, skip excluded IDs.
  // Using {{link.rawText}} instead of {{link.text}} preserves inline formatting
  // the author wrote in the link text (backticks, emphasis, etc.), so a source
  // link like [`foo.yaml`](…) still reads as [`foo.yaml`](new/path) after rewrite.
  // Targets with no packaged location strip instead — see bundledLinkTemplate.
  rules.push({
    match: {
      type: [...LOCAL_TYPES],
      ...(excludedIds.length > 0 ? { excludeResourceIds: excludedIds } : {}),
    },
    template: bundledLinkTemplate(stripTemplate),
  });

  // Final catch-all: local links excluded BY ID, which the rule above skips.
  if (excludedIds.length > 0) {
    rules.push({
      match: { type: [...LOCAL_TYPES] },
      template: stripTemplate,
    });
  }

  return rules;
}


// ============================================================================
// File Copy + Rewrite
// ============================================================================

/** Shared context for copying and rewriting files during packaging */
interface CopyRewriteContext {
  pathMap: Map<string, string>;
  rewriteLinks: boolean;
  fromRegistry: WalkableRegistry;
  toRegistry: ResourceRegistry;
  rewriteRules: LinkRewriteRule[];
  templateContext?: Record<string, unknown>;
  /** Per-collection frontmatter JSON Schemas, keyed by collection ID. Drives Gap 3 frontmatter URI-ref rewriting. */
  collectionSchemas: Map<string, object>;
  /** Absolute path to the project root — required for RFC 3986 §4.2 leading-`/` href resolution in frontmatter. */
  projectRoot: string;
  /** Sink for non-fatal copy/rewrite diagnostics (verbatim copies, un-appliable rewrites). */
  warn: (message: string) => void;
}

/**
 * Copy SKILL.md and all linked files to the output directory,
 * rewriting links using transformContent().
 */
async function copyAndRewriteFiles(
  skillPath: string,
  bundledFiles: string[],
  ctx: CopyRewriteContext,
): Promise<void> {
  // Copy SKILL.md
  const skillTargetPath = ctx.pathMap.get(toForwardSlash(skillPath));
  if (skillTargetPath) {
    await copyAndRewriteFile(skillPath, skillTargetPath, ctx);
  }

  // Copy all linked files
  for (const linkedFile of bundledFiles) {
    const targetPath = ctx.pathMap.get(toForwardSlash(linkedFile));
    if (targetPath === undefined) {
      continue;
    }

    await copyAndRewriteFile(linkedFile, targetPath, ctx);
  }
}

/**
 * Copy a single file, optionally rewriting markdown links using transformContent().
 *
 * For markdown files with rewriteLinks enabled:
 * 1. Reads the source file
 * 2. Finds the corresponding resource in the "from" registry
 * 3. Calls transformContent() with the resource's links, unified rules, and "to" registry
 * 4. Writes the result
 *
 * All link rewriting (bundled, excluded, inline, reference-style definitions)
 * is handled by a single transformContent() call with ordered rules.
 *
 * For non-markdown files, performs a plain binary copy.
 */
async function copyAndRewriteFile(
  sourcePath: string,
  targetPath: string,
  ctx: CopyRewriteContext,
): Promise<void> {
  // Ensure target directory exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetPath is constructed from validated paths
  await mkdir(dirname(targetPath), { recursive: true });

  const lower = sourcePath.toLowerCase();
  const isMarkdown = lower.endsWith('.md');
  const isHtml = lower.endsWith('.html') || lower.endsWith('.htm');

  // Non-rewritable files or rewriting disabled: plain binary copy
  if ((!isMarkdown && !isHtml) || !ctx.rewriteLinks) {
    await copyFile(sourcePath, targetPath);
    return;
  }

  // Read source file
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- sourcePath is validated
  const content = await readFile(sourcePath, 'utf-8');

  // Look up the resource in the "from" registry
  const resource = ctx.fromRegistry.getResource(safePath.resolve(sourcePath));

  if (!resource) {
    // Resource not in registry — write content as-is. For HTML this is only
    // reachable on an ID collision (e.g. page.html + page.md), where the asset
    // is copied verbatim and its links are NOT rewritten (v1 limitation,
    // mirrors the pre-existing asset-collision behavior).
    ctx.warn(
      `Copied '${sourcePath}' verbatim without link rewriting: it is not in the resource registry ` +
        `(typically an ID collision with a same-named markdown file). Source-relative links inside it are not rewritten.`,
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetPath is constructed from validated paths
    await writeFile(targetPath, content, 'utf-8');
    return;
  }

  // HTML: offset-splice link rewrite (no frontmatter, no template body rewrite).
  if (isHtml) {
    const rewriteHref = buildHrefRewriter(
      ctx.fromRegistry,
      ctx.toRegistry,
      sourcePath,
      targetPath,
      ctx.projectRoot,
    );
    const rewritten = rewriteHtmlLinks(content, rewriteHref, (info) => {
      ctx.warn(
        `Could not rewrite <${info.tagName} ${info.attr}="${info.from}"> in '${sourcePath}' (${info.reason}); ` +
          `the original value was kept.`,
      );
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetPath is constructed from validated paths
    await writeFile(targetPath, rewritten, 'utf-8');
    return;
  }

  // Parse once via FrontmatterEditor so comments survive any frontmatter
  // rewrites. The body is held verbatim; we run it through transformContent
  // for the existing rule/template body-link rewrite contract (unchanged).
  const editor = openFrontmatter(content);

  // Body rewrite (existing behavior, unchanged contract).
  editor.body = transformContent(editor.body, resource.links, {
    linkRewriteRules: ctx.rewriteRules,
    resourceRegistry: ctx.toRegistry,
    sourceFilePath: targetPath, // Output path so relativePath is computed from output location
    ...(ctx.templateContext === undefined ? {} : { context: ctx.templateContext }),
  });

  // Frontmatter URI-ref rewrite (Gap 3) — parity with body. Apply every
  // collection schema that matches this resource. The rewrite policy reuses
  // the same path-map lookups that body rewriting consumes, so frontmatter
  // and body agree on target paths.
  const matchingCollections = (resource.collections ?? []).filter(
    (id) => ctx.collectionSchemas.has(id),
  );
  if (matchingCollections.length > 0) {
    const rewriteHref = buildHrefRewriter(
      ctx.fromRegistry,
      ctx.toRegistry,
      sourcePath,
      targetPath,
      ctx.projectRoot,
    );
    for (const collectionId of matchingCollections) {
      const schema = ctx.collectionSchemas.get(collectionId);
      if (schema) {
        rewriteFrontmatterUriReferencesFromSchema(editor, schema, rewriteHref);
      }
    }
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetPath is constructed from validated paths
  await writeFile(targetPath, editor.toString(), 'utf-8');
}

/**
 * Build the per-href rewrite callback used for frontmatter URI-refs and HTML attributes.
 *
 * Mirrors the body-rewrite path so frontmatter and body link rewriting agree
 * on target paths:
 *   1. Resolve the href against `sourcePath` (RFC 3986 — leading `/` =
 *      project-root-relative; bare relative = source-dir-relative).
 *   2. Look up the resolved file in the `fromRegistry` by absolute path.
 *   3. If found, look up its output entry in `toRegistry` by ID and return
 *      a path relative to the OUTPUT file location (`dirname(targetPath)`),
 *      preserving any anchor fragment from the original href.
 *   4. Anchor-only, unresolved-absolute, or unknown hrefs pass through
 *      unchanged.
 *
 * Returns the original href when no rewrite applies.
 */
function buildHrefRewriter(
  fromRegistry: WalkableRegistry,
  toRegistry: ResourceRegistry,
  sourcePath: string,
  targetPath: string,
  projectRoot: string,
): (href: string) => string {
  const targetDir = dirname(targetPath);
  return (href) => {
    const resolution = resolveLocalHref(href, sourcePath, projectRoot);
    if (resolution.kind !== 'resolved') {
      // anchor_only | absolute_no_root | absolute_escapes_root — leave unchanged.
      return href;
    }
    const fromResource = fromRegistry.getResource(resolution.resolvedPath);
    if (!fromResource) {
      return href;
    }
    const toResource = toRegistry.getResourceById(fromResource.id);
    if (!toResource) {
      return href;
    }
    const relative = toForwardSlash(safePath.relative(targetDir, toResource.filePath));
    return resolution.anchor === undefined ? relative : `${relative}#${resolution.anchor}`;
  };
}


// ============================================================================
// Post-Build Integrity Checks
// ============================================================================

/**
 * Verify no SKILL.md files exist in subdirectories of the skill output.
 *
 * A SKILL.md is a skill definition marker — it declares the existence and identity
 * of a skill. If another skill's SKILL.md is bundled as a resource, it creates
 * duplicate skill definitions that cause:
 * - Marketplace sync rejection ("Duplicate skill name")
 * - Consumers discovering phantom skills in subdirectories
 *
 * This should never happen because the link graph walker excludes SKILL.md targets,
 * but this check acts as a safety net in case files are introduced through other means.
 */
async function validateNoNestedSkillMd(outputPath: string, skillName: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- outputPath is validated
  const entries = readdirSync(outputPath, { recursive: true, withFileTypes: true });
  const nestedSkillMds = entries
    .filter(entry => entry.isFile() && entry.name === 'SKILL.md')
    .map(entry => safePath.relative(outputPath, safePath.join(entry.parentPath, entry.name)))
    .filter(relativePath => relativePath !== 'SKILL.md'); // Exclude the root SKILL.md

  if (nestedSkillMds.length > 0) {
    throw new Error(
      `SKILL.md found inside skill "${skillName}" at: ${nestedSkillMds.join(', ')}\n` +
      `A SKILL.md was bundled as a resource — this creates a duplicate skill definition\n` +
      `in the build output, which breaks marketplace sync and confuses skill consumers.\n\n` +
      `Fix: Replace the markdown link to the other skill's SKILL.md with a text reference:\n` +
      `  Instead of: [other skill](../other-skill/SKILL.md)\n` +
      `  Use:        For details, load the \`other-skill\` skill.`,
    );
  }
}

// ============================================================================
// Metadata Extraction
// ============================================================================

/**
 * Extract skill metadata from SKILL.md frontmatter or content
 */
function extractSkillMetadata(
  parseResult: ParseResult,
  skillPath: string
): SkillMetadata {
  const frontmatter = parseResult.frontmatter ?? {};

  // Extract name from frontmatter (with validation)
  const frontmatterName = frontmatter['name'];
  const validFrontmatterName = typeof frontmatterName === 'string' && frontmatterName.trim() !== ''
    ? frontmatterName
    : undefined;

  // Try: frontmatter → H1 title → filename
  const name =
    validFrontmatterName ??
    extractH1Title(parseResult.content) ??
    basename(skillPath).replace(/\.md$/i, '');

  // Extract optional fields using bracket notation
  const description = frontmatter['description'];
  const version = frontmatter['version'];
  const license = frontmatter['license'];
  const author = frontmatter['author'];

  // Build result object with conditional properties (exactOptionalPropertyTypes)
  const result: SkillMetadata = {
    name: name.trim(),
  };

  if (typeof description === 'string') {
    result.description = description;
  }
  if (typeof version === 'string') {
    result.version = version;
  }
  if (typeof license === 'string') {
    result.license = license;
  }
  if (typeof author === 'string') {
    result.author = author;
  }

  return result;
}

/**
 * Extract H1 title from markdown content
 *
 * @param content - Markdown content
 * @returns The H1 title text, or undefined if not found
 */
export function extractH1Title(content: string): string | undefined {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      return trimmed.slice(2).trim();
    }
  }
  return undefined;
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Find the common ancestor directory of all file paths
 *
 * @param filePaths - Array of absolute file paths
 * @returns Common ancestor directory path
 */
export function findCommonAncestor(filePaths: string[]): string {
  if (filePaths.length === 0) {
    return process.cwd();
  }

  if (filePaths.length === 1) {
    return dirname(filePaths[0] ?? process.cwd());
  }

  // Normalize all paths
  const normalizedPaths = filePaths.map(p => safePath.resolve(p));

  // Split into path segments
  // eslint-disable-next-line local/no-hardcoded-path-split -- Paths are normalized to forward slashes by toForwardSlash()
  const pathSegments = normalizedPaths.map(p => p.split('/'));

  // Find common prefix
  const firstPath = pathSegments[0] ?? [];
  let commonDepth = 0;

  for (const [i, segment] of firstPath.entries()) {
    const allMatch = pathSegments.every(segments => segments[i] === segment);

    if (!allMatch) {
      break;
    }

    commonDepth = i + 1;
  }

  // If no common directory (different roots), use first file's directory
  if (commonDepth === 0) {
    return dirname(filePaths[0] ?? process.cwd());
  }

  // Reconstruct common ancestor path
  const commonSegments = firstPath.slice(0, commonDepth);
  return commonSegments.join('/');
}

/**
 * Generate target path based on naming strategy
 *
 * @param filePath - Absolute path to the source file
 * @param basePath - Base path to calculate relative path from
 * @param strategy - Naming strategy to use
 * @param stripPrefix - Path prefix to remove before applying strategy (works for all strategies)
 * @returns Target path (relative) for the packaged resource
 */
export function generateTargetPath(
  filePath: string,
  basePath: string,
  strategy: ResourceNamingStrategy = 'basename',
  stripPrefix?: string
): string {
  if (strategy === 'basename') {
    // Default: just use the filename (flat structure)
    return basename(filePath);
  }

  const ext = filePath.substring(filePath.lastIndexOf('.'));
  let relPath = safePath.relative(basePath, filePath);

  // Strip prefix from relative path (if specified)
  // Works for both resource-id and preserve-path strategies
  if (stripPrefix) {
    // Normalize separators for consistent matching
    const normalizedRelPath = relPath.replaceAll('\\', '/');
    const normalizedPrefix = stripPrefix.replaceAll('\\', '/').replace(/\/$/, ''); // Remove trailing slash

    if (normalizedRelPath.startsWith(normalizedPrefix + '/')) {
      // Strip the prefix and leading slash
      relPath = normalizedRelPath.substring(normalizedPrefix.length + 1);
    } else if (normalizedRelPath.startsWith(normalizedPrefix)) {
      // Prefix without trailing slash
      relPath = normalizedRelPath.substring(normalizedPrefix.length);
      // Clean up any leading slash
      relPath = relPath.replace(/^\//, '');
    }
  }

  if (strategy === 'preserve-path') {
    // Preserve directory structure (creates subdirectories)
    return relPath;
  }

  // strategy === 'resource-id': Flatten path to kebab-case filename
  // Convert path to kebab-case identifier (all in one filename)
  const pathWithoutExt = relPath.substring(0, relPath.length - ext.length);
  const resourceId = pathWithoutExt
    .replaceAll(/[/\\]+/g, '-')     // Path separators to hyphens
    .replaceAll(/[_\s]+/g, '-')     // Underscores and spaces to hyphens
    .toLowerCase()
    .replaceAll(/[^\da-z-]/g, '')   // Remove non-alphanumeric except hyphens
    .replaceAll(/-{2,}/g, '-')      // Collapse multiple hyphens
    .replace(/^-/, '')               // Trim leading hyphen
    .replace(/-$/, '');              // Trim trailing hyphen

  return resourceId + ext;
}

// ============================================================================
// Artifact Generation
// ============================================================================

/** ZIP size threshold for warning (4 MB in bytes) */
const ZIP_SIZE_WARN_BYTES = 4 * 1024 * 1024;
/** ZIP size threshold for error (8 MB in bytes) */
const ZIP_SIZE_ERROR_BYTES = 8 * 1024 * 1024;

/**
 * Thrown when a claude-web ZIP exceeds the 8MB Claude.ai upload limit.
 * The CLI catches this and exits with code 1.
 */
export class ZipSizeLimitError extends Error {
  readonly sizeBytes: number;
  readonly limitBytes: number;

  constructor(sizeBytes: number, limitBytes: number) {
    const mb = (sizeBytes / 1024 / 1024).toFixed(1);
    super(
      `ZIP size ${mb}MB exceeds 8MB limit for Claude.ai upload. ` +
      `Reduce the number of linked resources or use --target claude-code.`
    );
    this.name = 'ZipSizeLimitError';
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * Validate ZIP file size and warn/error as appropriate.
 * Warns to stderr at 4MB, throws ZipSizeLimitError at 8MB.
 *
 * @param zipPath - Path to the ZIP file
 */
function validateZipSize(zipPath: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- zipPath is constructed from validated outputPath
  const stats = statSync(zipPath);
  const bytes = stats.size;

  if (bytes >= ZIP_SIZE_ERROR_BYTES) {
    throw new ZipSizeLimitError(bytes, ZIP_SIZE_ERROR_BYTES);
  }

  if (bytes >= ZIP_SIZE_WARN_BYTES) {
    const mb = (bytes / 1024 / 1024).toFixed(1);
    process.stderr.write(
      `warning: ZIP size ${mb}MB is approaching the 8MB Claude.ai upload limit.\n`
    );
  }
}

/**
 * Generate package artifacts in requested formats
 *
 * @param outputPath - Directory containing packaged skill
 * @param metadata - Skill metadata
 * @param formats - Formats to generate
 * @param target - Packaging target (for ZIP size validation on claude-web)
 * @returns Paths to generated artifacts
 */
async function generatePackageArtifacts(
  outputPath: string,
  metadata: SkillMetadata,
  formats: string[],
  target: PackagingTarget = DEFAULT_PACKAGING_TARGET
): Promise<Record<string, string>> {
  const artifacts: Record<string, string> = {};

  if (formats.includes('directory')) {
    artifacts['directory'] = outputPath;
  }

  if (formats.includes('zip')) {
    const zipPath = `${outputPath}.zip`;
    await createZipArchive(outputPath, zipPath);
    // Validate ZIP size for claude-web target (Anthropic upload limit)
    if (target === 'claude-web') {
      validateZipSize(zipPath);
    }
    artifacts['zip'] = zipPath;
  }

  if (formats.includes('npm')) {
    const tgzPath = await createNpmPackage(outputPath, metadata);
    artifacts['npm'] = tgzPath;
  }

  if (formats.includes('marketplace')) {
    const manifestPath = await createMarketplaceManifest(outputPath, metadata);
    artifacts['marketplace'] = manifestPath;
  }

  return artifacts;
}

/**
 * Create ZIP archive of packaged skill
 *
 * Uses adm-zip for fast, cross-platform ZIP creation.
 * ZIP format preferred over TAR for Windows compatibility.
 *
 * @param sourceDir - Directory to archive
 * @param zipPath - Output ZIP file path
 */
async function createZipArchive(sourceDir: string, zipPath: string): Promise<void> {
  // Import adm-zip dynamically (will be added as dependency)
  const AdmZip = (await import('adm-zip')).default;

  const zip = new AdmZip();

  // Add directory contents to ZIP
  zip.addLocalFolder(sourceDir);

  // Write ZIP file
  zip.writeZip(zipPath);
}

/**
 * Create npm package (package.json + tarball)
 *
 * @param outputPath - Directory containing packaged skill
 * @param metadata - Skill metadata
 * @returns Path to generated .tgz file
 */
async function createNpmPackage(
  outputPath: string,
  metadata: SkillMetadata
): Promise<string> {
  // Generate package.json
  const packageJson = {
    name: `@vat-skills/${metadata.name}`,
    version: metadata.version ?? '1.0.0',
    description: metadata.description ?? `${metadata.name} skill`,
    license: metadata.license ?? 'MIT',
    author: metadata.author,
    keywords: ['vat', 'skill', 'claude', 'agent'],
    files: ['**/*.md'],
  };

  const packageJsonPath = safePath.join(outputPath, PACKAGE_JSON_FILENAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path is constructed from validated outputPath
  await writeFile(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2),
    'utf-8'
  );

  // For now, just return a placeholder path
  // Full npm pack implementation would require running `npm pack`
  return `${outputPath}.tgz`;
}

/**
 * Create marketplace manifest (JSON descriptor)
 *
 * @param outputPath - Directory containing packaged skill
 * @param metadata - Skill metadata
 * @returns Path to generated manifest file
 */
async function createMarketplaceManifest(
  outputPath: string,
  metadata: SkillMetadata
): Promise<string> {
  const manifest = {
    name: metadata.name,
    version: metadata.version ?? '1.0.0',
    description: metadata.description,
    license: metadata.license ?? 'MIT',
    author: metadata.author,
    type: 'skill',
    entrypoint: 'SKILL.md',
    created: new Date().toISOString(),
  };

  const manifestPath = safePath.join(dirname(outputPath), `${metadata.name}.marketplace.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path is constructed from validated outputPath
  await writeFile(
    manifestPath,
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );

  return manifestPath;
}

/**
 * Get default output path for packaged skill
 *
 * Returns <skill-package-root>/dist/skills/<skill-name>
 *
 * @param skillPath - Path to SKILL.md
 * @param skillName - Name from frontmatter
 * @returns Default output path
 */
function getDefaultSkillOutputPath(skillPath: string, skillName: string): string {
  const skillPackageRoot = findPackageRoot(skillPath);
  return safePath.join(skillPackageRoot, 'dist', 'skills', skillName);
}

/**
 * Find the package root that contains the skill
 *
 * Walks up from the skill directory to find the nearest package.json
 *
 * @param skillPath - Path to SKILL.md
 * @param fallbackToSkillDir - If true, falls back to skill's directory instead of throwing
 * @returns Package root directory (or skill's directory if fallback enabled)
 */
function findPackageRoot(skillPath: string, fallbackToSkillDir = false): string {
  let currentDir = dirname(safePath.resolve(skillPath));
  const skillDir = currentDir;

  // Walk up until we find a package.json or hit the filesystem root
  while (currentDir !== dirname(currentDir)) {
    const packageJsonPath = safePath.join(currentDir, PACKAGE_JSON_FILENAME);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Searching for package.json
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }
    currentDir = dirname(currentDir);
  }

  // Not found - either throw or fallback
  if (fallbackToSkillDir) {
    return skillDir;
  }

  throw new Error(
    `Could not find package.json for skill at ${skillPath}. ` +
      `Skill must be within an npm package to generate default output path.`
  );
}

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
  ResourceRegistry,
  transformContent,
  type LinkRewriteRule,
  type ParseResult,
  type ResourceMetadata,
  parseMarkdown,
} from '@vibe-agent-toolkit/resources';
import { findProjectRoot, toForwardSlash, safePath, type GitTracker } from '@vibe-agent-toolkit/utils';

import { getTargetSubdir } from './content-type-routing.js';
import type { SkillFileEntry } from './files-config.js';
import { checkBrokenPackagedLinks, checkUnreferencedFiles } from './post-build-checks.js';
import { validateSkillForPackaging, type PackagingValidationResult } from './validators/packaging-validator.js';
import type { ValidationIssue } from './validators/types.js';
import { runValidationFramework, type FrameworkResult, type ValidationConfig } from './validators/validation-framework.js';
import { walkerExclusionsToIssues } from './validators/walker-to-issues.js';
import { walkLinkGraph, type WalkableRegistry } from './walk-link-graph.js';

const PACKAGE_JSON_FILENAME = 'package.json';

/** Default template for excluded links when no explicit template is configured — renders just the link text */
const DEFAULT_STRIP_TEMPLATE = '{{link.text}}';

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
 * Package multiple skills with a shared ResourceRegistry.
 *
 * Creates one registry for the entire project (crawling all .md files once),
 * then packages each skill against the shared registry. This eliminates
 * redundant I/O when building multiple skills from the same project.
 *
 * @param skills - Array of skill build specifications
 * @param projectRoot - Absolute path to the project root directory
 * @returns Array of package results (one per skill)
 *
 * @example
 * ```typescript
 * const specs: SkillBuildSpec[] = [
 *   { skillPath: '/project/skills/SKILL.md', options: { outputPath: '/out/skill-a' } },
 *   { skillPath: '/project/skills/SKILL2.md', options: { outputPath: '/out/skill-b' } },
 * ];
 * const results = await packageSkills(specs, '/project');
 * ```
 */
export async function packageSkills(
  skills: SkillBuildSpec[],
  projectRoot: string,
): Promise<PackageSkillResult[]> {
  // 1. Create one registry for the entire project
  const registry = await ResourceRegistry.fromCrawl({
    baseDir: projectRoot,
    include: ['**/*.md'],
  });
  registry.resolveLinks();

  // 2. Package each skill against the shared registry
  const results: PackageSkillResult[] = [];
  for (const { skillPath, options } of skills) {
    const result = await packageSkill(skillPath, { ...options, registry });
    results.push(result);
  }
  return results;
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

  // 2. Find project boundary (workspace root -> git root -> skill dir)
  const projectRoot = findProjectRoot(dirname(skillPath));
  const skillRoot = dirname(skillPath);

  // 3. Get or create the resource registry
  const registry = options.registry ?? await createStandaloneRegistry(projectRoot);

  // 4. Walk the link graph using registry data
  const linkFollowDepth = options.linkFollowDepth ?? 2;
  const excludeConfig = options.excludeReferencesFromBundle;
  const excludeNavigationFiles = options.excludeNavigationFiles ?? true;
  const maxDepth = linkFollowDepth === 'full' ? Infinity : linkFollowDepth;

  // Find the skill resource in the registry
  const skillResource = registry.getResource(safePath.resolve(skillPath));
  const skillResourceId = skillResource?.id ?? '';

  const packagerWalkOptions: Parameters<typeof walkLinkGraph>[2] = {
    maxDepth,
    excludeRules: excludeConfig?.rules ?? [],
    projectRoot,
    skillRootPath: safePath.resolve(skillPath),
    excludeNavigationFiles,
  };
  if (options.gitTracker !== undefined) {
    packagerWalkOptions.gitTracker = options.gitTracker;
  }
  const { bundledResources, bundledAssets, excludedReferences } = walkLinkGraph(
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
  const pathMap = buildPathMap(skillPath, bundledFiles, outputPath, resourceNaming, namingBasePath, stripPrefix, target);

  // 8b. Apply files config: copy declared files and adjust path map
  const filesConfig = options.files ?? [];
  for (const fileEntry of filesConfig) {
    const absoluteSource = safePath.resolve(safePath.join(projectRoot, fileEntry.source));
    const absoluteDest = safePath.join(outputPath, fileEntry.dest);

    // Validate source exists at build time
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- source path from validated config
    if (!existsSync(absoluteSource)) {
      throw new Error(
        `files entry for skill '${skillMetadata.name}': source '${fileEntry.source}' does not exist. ` +
        `Has your project's build step run?`
      );
    }

    // If this source was auto-discovered, override its destination; otherwise add it
    pathMap.set(toForwardSlash(absoluteSource), absoluteDest);
  }

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
  });

  // 12b. Copy files config entries that were not auto-discovered via link traversal.
  await copyFilesConfigEntries(filesConfig, bundledFiles, projectRoot, outputPath);

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
    ...await checkUnreferencedFiles(outputPath),
    ...await checkBrokenPackagedLinks(outputPath),
  ];
  const rawLinkIssues = walkerExclusionsToIssues(excludedReferences, projectRoot);

  const framework = runValidationFramework(
    [...rawLinkIssues, ...rawPostBuildIssues],
    options.validation ?? {},
  );

  // 13c. Run full validation suite on built output
  const postBuildValidation = await runPostBuildValidation(outputPath, options.validation);

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
    framework,
    excludedReferences,
    skillRoot,
  });
}

/**
 * Run full validation suite against built output (context = 'built').
 * Source-only codes are automatically filtered out by validateSkillForPackaging.
 */
async function runPostBuildValidation(
  outputPath: string,
  validation: ValidationConfig | undefined,
): Promise<PackagingValidationResult> {
  const builtSkillPath = safePath.join(outputPath, 'SKILL.md');
  return validateSkillForPackaging(
    builtSkillPath,
    validation ? { validation } : undefined,
    'built',
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
    hasErrors: input.framework.hasErrors || input.postBuildValidation.activeErrors.length > 0,
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
 * Create a standalone registry for a single skill (when no shared registry is provided).
 */
async function createStandaloneRegistry(projectRoot: string): Promise<ResourceRegistry> {
  const registry = await ResourceRegistry.fromCrawl({
    baseDir: projectRoot,
    include: ['**/*.md'],
  });
  registry.resolveLinks();
  return registry;
}

/**
 * Generate a synthetic resource ID for a non-markdown asset that collides with an
 * existing markdown resource. Uses the absolute asset path prefixed with `asset::`
 * to guarantee uniqueness — this id is used only for skill-packager internal
 * lookups (output registry + link rewriting), not for user-facing output.
 */
function synthesizeAssetId(assetPath: string): string {
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

// ============================================================================
// Path Map Building
// ============================================================================

/**
 * Determine the resource subdirectory for a file.
 *
 * For claude-web target: uses the existing references directory.
 * For claude-code target: uses content-type routing based on file extension.
 */
function getResourceSubdirForFile(filePath: string, target: PackagingTarget): string {
  if (target === 'claude-web') {
    return 'references';
  }
  return getTargetSubdir(filePath);
}

/**
 * Build a map of source paths (forward-slash normalized) to output paths.
 * Checks for filename collisions.
 */
function buildPathMap(
  skillPath: string,
  bundledFiles: string[],
  outputPath: string,
  resourceNaming: ResourceNamingStrategy,
  namingBasePath: string,
  stripPrefix?: string,
  target: PackagingTarget = DEFAULT_PACKAGING_TARGET,
): Map<string, string> {
  const pathMap = new Map<string, string>();
  pathMap.set(toForwardSlash(skillPath), safePath.join(outputPath, 'SKILL.md'));

  for (const linkedFile of bundledFiles) {
    const targetRelPath = generateTargetPath(
      linkedFile,
      namingBasePath,
      resourceNaming,
      stripPrefix
    );
    const fileSubdir = getResourceSubdirForFile(linkedFile, target);
    const targetPath = safePath.join(outputPath, fileSubdir, targetRelPath);

    // Check for filename collisions
    const existingSource = [...pathMap.entries()].find(
      ([_src, target]) => target === targetPath
    )?.[0];

    if (existingSource !== undefined && existingSource !== toForwardSlash(linkedFile)) {
      throw new Error(
        `Filename collision detected when packaging skill:\n` +
        `  File 1: ${existingSource}\n` +
        `  File 2: ${linkedFile}\n` +
        `  Both would be packaged as: ${targetRelPath}\n` +
        `\n` +
        `  To resolve: Use a different resourceNaming strategy or ensure unique filenames.\n` +
        `  Current strategy: ${resourceNaming}\n` +
        `  Try 'resource-id' or 'preserve-path' for path-based naming.`
      );
    }

    pathMap.set(toForwardSlash(linkedFile), targetPath);
  }

  return pathMap;
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

  // Rules 1+: Per-pattern exclude rules (if any)
  for (const rule of excludeRules) {
    rules.push({
      match: { type: 'local_file', pattern: rule.patterns },
      template: rule.template ?? defaultExcludeTemplate ?? DEFAULT_STRIP_TEMPLATE,
    });
  }

  // Rule N: Bundled links — match local_file, skip excluded IDs.
  // Using {{link.rawText}} instead of {{link.text}} preserves inline formatting
  // the author wrote in the link text (backticks, emphasis, etc.), so a source
  // link like [`foo.yaml`](…) still reads as [`foo.yaml`](new/path) after rewrite.
  rules.push({
    match: {
      type: 'local_file',
      ...(excludedIds.length > 0 ? { excludeResourceIds: excludedIds } : {}),
    },
    template: '[{{link.rawText}}]({{link.resource.relativePath}}{{link.fragment}})',
  });

  // Final catch-all: remaining local_file links (depth-exceeded, navigation, etc.)
  if (excludedIds.length > 0) {
    rules.push({
      match: { type: 'local_file' },
      template: defaultExcludeTemplate ?? DEFAULT_STRIP_TEMPLATE,
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
}

/**
 * Copy files config entries that were not auto-discovered via link traversal.
 *
 * Build artifacts declared in `files` (e.g. `dist/bin/cli.mjs → scripts/cli.mjs`)
 * are not in the link graph (the linked path points to `dest`, which doesn't exist
 * at source time). This step copies them explicitly to the output directory.
 */
async function copyFilesConfigEntries(
  filesConfig: SkillFileEntry[],
  bundledFiles: string[],
  projectRoot: string,
  outputPath: string,
): Promise<void> {
  const bundledFileSet = new Set(bundledFiles.map(f => toForwardSlash(f)));
  for (const fileEntry of filesConfig) {
    const absoluteSource = safePath.resolve(safePath.join(projectRoot, fileEntry.source));
    const absoluteDest = safePath.join(outputPath, fileEntry.dest);
    if (!bundledFileSet.has(toForwardSlash(absoluteSource))) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- source path from validated config
      await mkdir(dirname(absoluteDest), { recursive: true });
      await copyFile(absoluteSource, absoluteDest);
    }
  }
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

  // Non-markdown files or rewriting disabled: plain binary copy
  if (!sourcePath.endsWith('.md') || !ctx.rewriteLinks) {
    await copyFile(sourcePath, targetPath);
    return;
  }

  // Read source file
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- sourcePath is validated
  const content = await readFile(sourcePath, 'utf-8');

  // Look up the resource in the "from" registry
  const resource = ctx.fromRegistry.getResource(safePath.resolve(sourcePath));

  if (!resource) {
    // Resource not in registry — write content as-is
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetPath is constructed from validated paths
    await writeFile(targetPath, content, 'utf-8');
    return;
  }

  // Unified link rewriting: bundled + excluded, inline + definitions
  const transformed = transformContent(content, resource.links, {
    linkRewriteRules: ctx.rewriteRules,
    resourceRegistry: ctx.toRegistry,
    sourceFilePath: targetPath, // Output path so relativePath is computed from output location
    ...(ctx.templateContext === undefined ? {} : { context: ctx.templateContext }),
  });

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetPath is constructed from validated paths
  await writeFile(targetPath, transformed, 'utf-8');
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
function findCommonAncestor(filePaths: string[]): string {
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
function generateTargetPath(
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

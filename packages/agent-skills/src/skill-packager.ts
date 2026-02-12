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

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import {
  ResourceRegistry,
  transformContent,
  type LinkRewriteRule,
  type ParseResult,
  parseMarkdown,
} from '@vibe-agent-toolkit/resources';
import { findProjectRoot, renderTemplate, toForwardSlash } from '@vibe-agent-toolkit/utils';

import type { DefaultRule, ExcludeRule } from './link-collector.js';
import { walkLinkGraph, type WalkableRegistry } from './walk-link-graph.js';

const PACKAGE_JSON_FILENAME = 'package.json';

/** Default template for excluded links when no explicit template is configured — renders just the link text */
const DEFAULT_STRIP_TEMPLATE = '{{link.text}}';

/**
 * Resource naming strategy type
 */
export type ResourceNamingStrategy = 'basename' | 'resource-id' | 'preserve-path';

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
  const skillResource = registry.getResource(resolve(skillPath));
  const skillResourceId = skillResource?.id ?? '';

  const { bundledResources, bundledAssets, excludedReferences } = walkLinkGraph(
    skillResourceId,
    registry as WalkableRegistry,
    {
      maxDepth,
      excludeRules: excludeConfig?.rules ?? [],
      projectRoot,
      excludeNavigationFiles,
    },
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
  const resolvedOutput = toForwardSlash(resolve(outputPath));
  const sourceInOutput = toForwardSlash(resolve(skillPath)).startsWith(resolvedOutput + '/');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- outputPath is validated
  if (!sourceInOutput && existsSync(resolvedOutput)) {
    await rm(resolvedOutput, { recursive: true });
  }

  // 8. Build path map for file copying and link rewriting
  const namingBasePath = projectRoot;
  const pathMap = buildPathMap(skillPath, bundledFiles, outputPath, resourceNaming, namingBasePath, stripPrefix);

  // 9. Build "to" registry for link rewriting (maps same resource IDs to output paths)
  const outputResources = bundledResources.map(resource => ({
    ...resource,
    filePath: pathMap.get(toForwardSlash(resource.filePath)) ?? resource.filePath,
  }));
  // Include the skill resource itself in the "to" registry
  if (skillResource) {
    outputResources.push({
      ...skillResource,
      filePath: join(outputPath, 'SKILL.md'),
    });
  }
  const outputRegistry = ResourceRegistry.fromResources(outputPath, outputResources);

  // 10. Build rewrite rules for transformContent (bundled links only)
  const rewriteRules = buildRewriteRules();

  // 11. Build excluded link template map (for pre-pass rewriting)
  const defaultRule: DefaultRule = {
    ...(excludeConfig?.defaultTemplate ? { template: excludeConfig.defaultTemplate } : {}),
  };
  const excludedTemplateMap = buildExcludedLinkTemplates(
    excludedReferences, defaultRule, skillMetadata.name, skillRoot,
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
    excludedTemplateMap,
  });

  // 13. Generate distribution artifacts
  const artifacts = await generatePackageArtifacts(
    outputPath,
    skillMetadata,
    formats
  );

  // Get relative paths for result
  const relativeLinkedFiles = bundledFiles.map(f =>
    toForwardSlash(relative(effectiveBasePath, f))
  );

  // Build excluded reference paths for result
  const result: PackageSkillResult = {
    outputPath,
    skill: skillMetadata,
    files: {
      root: 'SKILL.md',
      dependencies: relativeLinkedFiles,
    },
    artifacts,
  };

  if (excludedReferences.length > 0) {
    // Deduplicate excluded reference paths for the result
    const uniqueExcludedPaths = [...new Set(
      excludedReferences.map(r => toForwardSlash(relative(skillRoot, r.path)))
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

// ============================================================================
// Path Map Building
// ============================================================================

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
): Map<string, string> {
  const pathMap = new Map<string, string>();
  pathMap.set(toForwardSlash(skillPath), join(outputPath, 'SKILL.md'));

  for (const linkedFile of bundledFiles) {
    const targetRelPath = generateTargetPath(
      linkedFile,
      namingBasePath,
      resourceNaming,
      stripPrefix
    );
    const targetPath = join(outputPath, 'resources', targetRelPath);

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
 * Build link rewrite rules for transformContent() — handles bundled links only.
 *
 * Excluded links are handled separately in rewriteExcludedLinks() because
 * excluded resources aren't in the output registry, so transformContent()
 * can't resolve them for pattern matching or template context.
 */
function buildRewriteRules(): LinkRewriteRule[] {
  // Bundled local_file links — rewrite href to new relative path
  // This rule uses link.resource.relativePath which transformContent computes from the "to" registry
  return [{
    match: { type: 'local_file' },
    template: '[{{link.text}}]({{link.resource.relativePath}}{{link.fragment}})',
  }];
}

/**
 * Build a map of excluded link absolute paths → rendered template text.
 *
 * For each excluded reference, computes the final replacement text by rendering
 * the appropriate template with context variables (link.text, link.fileName,
 * link.filePath, skill.name).
 *
 * @returns Map from absolute target path → rendered template string
 */
function buildExcludedLinkTemplates(
  excludedReferences: Array<{
    path: string;
    matchedRule?: ExcludeRule | undefined;
    excludeReason?: string | undefined;
    linkText?: string | undefined;
    linkHref?: string | undefined;
  }>,
  defaultRule: DefaultRule,
  skillName: string,
  skillRoot: string,
): Map<string, string> {
  const templateMap = new Map<string, string>();

  for (const ref of excludedReferences) {
    // Skip directory targets and outside-project (they don't need template rewriting)
    if (ref.excludeReason === 'directory-target' || ref.excludeReason === 'outside-project') {
      continue;
    }

    // Determine the template to use (with DEFAULT_STRIP_TEMPLATE as final fallback)
    let template: string;
    if (ref.excludeReason === 'pattern-matched' && ref.matchedRule) {
      template = ref.matchedRule.template ?? defaultRule.template ?? DEFAULT_STRIP_TEMPLATE;
    } else {
      // depth-exceeded, navigation-file, etc.
      template = defaultRule.template ?? DEFAULT_STRIP_TEMPLATE;
    }

    // Pre-render with all context variables
    const targetPath = ref.path;
    const relPath = toForwardSlash(relative(skillRoot, targetPath));
    const fileName = basename(targetPath);

    const rendered = renderTemplate(template, {
      link: {
        text: ref.linkText ?? '',
        fileName,
        filePath: relPath,
        uri: ref.linkHref ?? '',
      },
      skill: {
        name: skillName,
      },
    });

    templateMap.set(targetPath, rendered);
  }

  return templateMap;
}

/**
 * Rewrite excluded links in markdown content.
 *
 * This is a pre-pass before transformContent(). It replaces links whose targets
 * are in the excludedTemplateMap with the pre-rendered template text.
 *
 * @param content - Markdown content
 * @param sourceFilePath - Absolute path of the source file (for resolving relative hrefs)
 * @param excludedTemplateMap - Map from absolute target path → rendered replacement
 * @returns Content with excluded links rewritten
 */
function rewriteExcludedLinks(
  content: string,
  sourceFilePath: string,
  excludedTemplateMap: Map<string, string>,
): string {
  if (excludedTemplateMap.size === 0) {
    return content;
  }

  return content.replaceAll(
    /\[([^\]]*)\]\(([^)]*)\)/g, // eslint-disable-line sonarjs/slow-regex -- Negated char classes [^\]] and [^)] are non-backtracking
    (fullMatch, _text: string, href: string) => {
      // Skip external URLs and anchors
      if (href.startsWith('http://') || href.startsWith('https://') ||
          href.startsWith('mailto:') || href.startsWith('#')) {
        return fullMatch;
      }

      // Strip anchor
      const anchorIndex = href.indexOf('#');
      const linkPath = anchorIndex === -1 ? href : href.slice(0, anchorIndex);

      if (!linkPath) {
        return fullMatch;
      }

      // Resolve to absolute path and check against excluded map
      const resolvedTarget = resolve(dirname(sourceFilePath), linkPath);
      const rendered = excludedTemplateMap.get(resolvedTarget);

      if (rendered !== undefined) {
        return rendered;
      }

      return fullMatch;
    }
  );
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
  excludedTemplateMap: Map<string, string>;
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
 * 2. Rewrites excluded links (pre-pass, using excludedTemplateMap)
 * 3. Finds the corresponding resource in the "from" registry
 * 4. Calls transformContent() with the resource's links, rules, and "to" registry
 * 5. Writes the result
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

  // Non-markdown files: plain binary copy (no link rewriting)
  if (!sourcePath.endsWith('.md')) {
    await copyFile(sourcePath, targetPath);
    return;
  }

  if (!ctx.rewriteLinks) {
    await copyFile(sourcePath, targetPath);
    return;
  }

  // Read source file
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- sourcePath is validated
  const content = await readFile(sourcePath, 'utf-8');

  // Pre-pass: Rewrite excluded links before transformContent
  // This must happen first because excluded resources aren't in the output registry
  const withExcludedRewritten = rewriteExcludedLinks(content, sourcePath, ctx.excludedTemplateMap);

  // Look up the resource in the "from" registry
  const resource = ctx.fromRegistry.getResource(resolve(sourcePath));

  if (!resource) {
    // Resource not in registry (unlikely but possible) — fall back to pathMap-based rewriting
    const rewritten = rewriteWithPathMap(withExcludedRewritten, sourcePath, targetPath, ctx.pathMap);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetPath is constructed from validated paths
    await writeFile(targetPath, rewritten, 'utf-8');
    return;
  }

  // Use transformContent() for bundled link rewriting
  const transformed = transformContent(withExcludedRewritten, resource.links, {
    linkRewriteRules: ctx.rewriteRules,
    resourceRegistry: ctx.toRegistry,
    sourceFilePath: targetPath, // Use output path so relativePath is computed from output location
  });

  // Handle reference-style links that transformContent doesn't cover
  const withRefs = rewriteReferenceLinks(transformed, sourcePath, targetPath, ctx.pathMap);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetPath is constructed from validated paths
  await writeFile(targetPath, withRefs, 'utf-8');
}

/**
 * Rewrite reference-style link definitions: [ref]: href
 *
 * transformContent() only handles inline `[text](href)` links.
 * Reference-style links `[ref]: href` need separate handling.
 */
function rewriteReferenceLinks(
  content: string,
  sourcePath: string,
  targetPath: string,
  pathMap: Map<string, string>,
): string {
  return content.replaceAll(
    /^\[([^\]]*?)\]:\s*(.+)$/gm, // eslint-disable-line sonarjs/slow-regex -- Controlled markdown reference link definitions
    (_match, ref: string, href: string) => {
      const trimmedHref = href.trim();

      // Skip external URLs and anchors
      if (trimmedHref.startsWith('http://') || trimmedHref.startsWith('https://') ||
          trimmedHref.startsWith('mailto:') || trimmedHref.startsWith('#')) {
        return `[${ref}]: ${trimmedHref}`;
      }

      // Split anchor from path
      const anchorIndex = trimmedHref.indexOf('#');
      const linkPath = anchorIndex === -1 ? trimmedHref : trimmedHref.slice(0, anchorIndex);
      const anchor = anchorIndex === -1 ? '' : trimmedHref.slice(anchorIndex);

      if (!linkPath) {
        return `[${ref}]: ${trimmedHref}`;
      }

      // Resolve the target and look up in path map
      const resolvedTarget = resolve(dirname(sourcePath), linkPath);
      const normalizedTarget = toForwardSlash(resolvedTarget);
      const newTarget = pathMap.get(normalizedTarget);

      if (newTarget === undefined) {
        return `[${ref}]: ${trimmedHref}`;
      }

      // Compute relative path from output location
      const newRelPath = toForwardSlash(relative(dirname(targetPath), newTarget));
      // eslint-disable-next-line local/no-path-startswith -- newRelPath is already forward-slash normalized
      const cleanedRelPath = newRelPath.startsWith('./') ? newRelPath.slice(2) : newRelPath;

      return `[${ref}]: ${cleanedRelPath}${anchor}`;
    }
  );
}

/**
 * Fallback rewriting using pathMap when a resource is not in the registry.
 * This handles edge cases like markdown files that weren't crawled.
 */
function rewriteWithPathMap(
  content: string,
  sourcePath: string,
  targetPath: string,
  pathMap: Map<string, string>,
): string {
  let result = content.replaceAll(
    /\[([^\]]*?)\]\(([^)]*?)\)/g, // eslint-disable-line sonarjs/slow-regex -- Negated char classes are non-backtracking
    (fullMatch, text: string, href: string) => {
      // Skip external URLs and anchors
      if (href.startsWith('http://') || href.startsWith('https://') ||
          href.startsWith('mailto:') || href.startsWith('#')) {
        return fullMatch;
      }

      const anchorIndex = href.indexOf('#');
      const linkPath = anchorIndex === -1 ? href : href.slice(0, anchorIndex);
      const anchor = anchorIndex === -1 ? '' : href.slice(anchorIndex);

      if (!linkPath) {
        return fullMatch;
      }

      const resolvedTarget = resolve(dirname(sourcePath), linkPath);
      const normalizedTarget = toForwardSlash(resolvedTarget);
      const newTarget = pathMap.get(normalizedTarget);

      if (newTarget === undefined) {
        return fullMatch;
      }

      const newRelPath = toForwardSlash(relative(dirname(targetPath), newTarget));
      // eslint-disable-next-line local/no-path-startswith -- newRelPath is already forward-slash normalized
      const cleanedRelPath = newRelPath.startsWith('./') ? newRelPath.slice(2) : newRelPath;

      return `[${text}](${cleanedRelPath}${anchor})`;
    }
  );

  // Also handle reference-style links
  result = rewriteReferenceLinks(result, sourcePath, targetPath, pathMap);

  return result;
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
  const normalizedPaths = filePaths.map(p => toForwardSlash(resolve(p)));

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
  let relPath = relative(basePath, filePath);

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

/**
 * Generate package artifacts in requested formats
 *
 * @param outputPath - Directory containing packaged skill
 * @param metadata - Skill metadata
 * @param formats - Formats to generate
 * @returns Paths to generated artifacts
 */
async function generatePackageArtifacts(
  outputPath: string,
  metadata: SkillMetadata,
  formats: string[]
): Promise<Record<string, string>> {
  const artifacts: Record<string, string> = {};

  if (formats.includes('directory')) {
    artifacts['directory'] = outputPath;
  }

  if (formats.includes('zip')) {
    const zipPath = `${outputPath}.zip`;
    await createZipArchive(outputPath, zipPath);
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

  const packageJsonPath = join(outputPath, PACKAGE_JSON_FILENAME);
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

  const manifestPath = join(dirname(outputPath), `${metadata.name}.marketplace.json`);
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
  return join(skillPackageRoot, 'dist', 'skills', skillName);
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
  let currentDir = dirname(resolve(skillPath));
  const skillDir = currentDir;

  // Walk up until we find a package.json or hit the filesystem root
  while (currentDir !== dirname(currentDir)) {
    const packageJsonPath = join(currentDir, PACKAGE_JSON_FILENAME);
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

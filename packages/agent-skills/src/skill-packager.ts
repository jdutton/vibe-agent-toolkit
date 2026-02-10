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
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { parseMarkdown, type ParseResult } from '@vibe-agent-toolkit/resources';
import { renderTemplate, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { collectLinks } from './link-collector.js';
import type { DefaultRule, ExcludeRule } from './link-collector.js';

const PACKAGE_JSON_FILENAME = 'package.json';
const DEFAULT_STRIP_TEMPLATE = '{{link.text}}';
const REPLACE_ENTIRE = 'replace-entire' as const;

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
   * // Original: knowledge-base/manuscript/lobs/homeowners/overview.md
   * // basename:       overview.md (may conflict)
   * // resource-id:    manuscript-lobs-homeowners-overview.md (with stripPrefix: 'knowledge-base-')
   * // preserve-path:  manuscript/lobs/homeowners/overview.md (creates subdirectories)
   */
  resourceNaming?: ResourceNamingStrategy;

  /**
   * Path prefix to strip before applying naming strategy
   *
   * Removes a directory prefix from the relative path before the naming strategy is applied.
   * Works with both 'resource-id' and 'preserve-path' strategies.
   *
   * @example
   * // Original: knowledge-base/manuscript/lobs/homeowners/overview.md
   * // stripPrefix: 'knowledge-base'
   * //
   * // resource-id:    manuscript-lobs-homeowners-overview.md
   * // preserve-path:  manuscript/lobs/homeowners/overview.md
   */
  stripPrefix?: string;

  /** How deep to follow markdown links (default: 2) */
  linkFollowDepth?: number | 'full' | undefined;

  /** Exclude patterns and rewrite templates for non-bundled links */
  excludeReferencesFromBundle?: {
    rules?: Array<{
      patterns: string[];
      template?: string | undefined;
    }> | undefined;
    defaultTemplate?: string | undefined;
  } | undefined;
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

  // 2. Find package boundary (to prevent collecting files from other packages)
  // If no package.json found, use skill's directory as boundary (for tests)
  const packageRoot = findPackageRootOrFallback(skillPath);
  const skillRoot = dirname(skillPath);

  // 3. Collect all linked resources using unified link collector
  const linkFollowDepth = options.linkFollowDepth ?? 2;
  const excludeConfig = options.excludeReferencesFromBundle;
  const maxDepth = linkFollowDepth === 'full' ? Infinity : linkFollowDepth;
  const defaultRule: DefaultRule = {
    ...(excludeConfig?.defaultTemplate ? { template: excludeConfig.defaultTemplate } : {}),
  };

  const { bundledFiles, excludedReferences } = await collectLinks(skillPath, {
    maxDepth,
    excludeRules: excludeConfig?.rules ?? [],
    defaultRule,
    skillRoot,
    packageRoot,
  });

  // 4. Calculate common ancestor of all files (for proper relative path calculation)
  const allFiles = [skillPath, ...bundledFiles];
  const effectiveBasePath = findCommonAncestor(allFiles);

  // 5. Determine output path
  const outputPath = options.outputPath ??
    getDefaultSkillOutputPath(skillPath, skillMetadata.name);

  // 6. Build excluded file maps for link rewriting
  const excludedFileSet = new Set(excludedReferences.map(r => toForwardSlash(r.path)));
  const excludeRuleMap = new Map<string, { rule?: ExcludeRule | undefined; defaultRule: DefaultRule }>();

  for (const ref of excludedReferences) {
    const normalizedRefPath = toForwardSlash(ref.path);
    if (!excludeRuleMap.has(normalizedRefPath)) {
      excludeRuleMap.set(normalizedRefPath, {
        rule: ref.matchedRule,
        defaultRule,
      });
    }
  }

  // 7. Copy SKILL.md and all linked files (flat structure with configurable naming)
  const excludeCtx: ExcludeContext | undefined = excludedFileSet.size > 0
    ? { excludedFiles: excludedFileSet, ruleMap: excludeRuleMap, skillName: skillMetadata.name, skillRoot }
    : undefined;

  await copySkillResources(
    skillPath,
    bundledFiles,
    outputPath,
    { rewriteLinks, resourceNaming, stripPrefix, packageRoot, excludeCtx },
  );

  // 8. Generate distribution artifacts
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

/**
 * Context for excluded file link rewriting.
 * Groups the parameters needed to rewrite links targeting excluded files.
 */
interface ExcludeContext {
  /** Set of forward-slash normalized absolute paths excluded from bundle */
  excludedFiles: Set<string>;
  /** Map of excluded file paths to their rewrite rules */
  ruleMap: Map<string, { rule?: ExcludeRule | undefined; defaultRule: DefaultRule }>;
  /** Skill name for template rendering context */
  skillName: string;
  /** Skill root directory for template rendering context */
  skillRoot: string;
}

/**
 * Options for copying skill resources to the output directory.
 */
interface CopyResourcesOptions {
  rewriteLinks: boolean;
  resourceNaming?: ResourceNamingStrategy | undefined;
  stripPrefix?: string | undefined;
  packageRoot?: string | undefined;
  excludeCtx?: ExcludeContext | undefined;
}

/**
 * Copy SKILL.md and linked files to output directory
 *
 * Creates a FLAT structure with all files at the root level.
 * Rewrites links to work in the flattened structure.
 *
 * @param skillPath - Path to SKILL.md
 * @param linkedFiles - All linked files to copy
 * @param outputPath - Destination directory
 * @param options - Copy options including rewrite settings and exclude context
 */
async function copySkillResources(
  skillPath: string,
  linkedFiles: string[],
  outputPath: string,
  options: CopyResourcesOptions,
): Promise<void> {
  const {
    rewriteLinks,
    resourceNaming = 'basename',
    stripPrefix,
    packageRoot,
    excludeCtx,
  } = options;
  // Ensure output directory exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Output path is validated
  await mkdir(outputPath, { recursive: true });

  // Build a map of original paths to flattened paths
  // Normalize all keys for consistent lookup (handles path separator differences)
  const pathMap = new Map<string, string>();
  pathMap.set(toForwardSlash(skillPath), join(outputPath, 'SKILL.md'));

  // Determine base path for resource naming (fallback to skill directory)
  const namingBasePath = packageRoot ?? dirname(skillPath);

  // Map all linked files (using naming strategy - may create subdirectories)
  // Check for collisions
  for (const linkedFile of linkedFiles) {
    const targetRelPath = generateTargetPath(
      linkedFile,
      namingBasePath,
      resourceNaming,
      stripPrefix
    );
    const targetPath = join(outputPath, targetRelPath);

    // Check for filename collisions
    const existingSource = [...pathMap.entries()].find(
      ([_src, target]) => target === targetPath
    )?.[0];

    // Normalize paths for comparison (handles Windows backslash vs forward slash)
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

  // Copy SKILL.md
  await copyAndRewriteFile(
    skillPath,
    join(outputPath, 'SKILL.md'),
    pathMap,
    rewriteLinks,
    excludeCtx,
  );

  // Copy all linked files (structure depends on naming strategy)
  for (const linkedFile of linkedFiles) {
    const targetPath = pathMap.get(toForwardSlash(linkedFile));
    if (targetPath === undefined) {
      continue; // Should never happen, but satisfy type checker
    }

    await copyAndRewriteFile(
      linkedFile,
      targetPath,
      pathMap,
      rewriteLinks,
      excludeCtx,
    );
  }
}

/**
 * Copy a file, optionally rewriting markdown links
 *
 * For markdown files with rewriteLinks enabled, adjusts relative links to work
 * from the new location and replaces links to excluded files using templates.
 * For non-markdown files, performs a plain binary copy.
 *
 * @param sourcePath - Source file absolute path
 * @param targetPath - Target file absolute path
 * @param pathMap - Map of source paths to target paths (for flat structure)
 * @param rewriteLinks - Whether to rewrite links
 * @param excludeCtx - Context for excluded file link rewriting
 */
async function copyAndRewriteFile(
  sourcePath: string,
  targetPath: string,
  pathMap: Map<string, string>,
  rewriteLinks: boolean,
  excludeCtx?: ExcludeContext,
): Promise<void> {
  // Ensure target directory exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetPath is constructed from validated paths
  await mkdir(dirname(targetPath), { recursive: true });

  // Non-markdown files: plain binary copy (no link rewriting)
  if (!sourcePath.endsWith('.md')) {
    await copyFile(sourcePath, targetPath);
    return;
  }

  if (!rewriteLinks) {
    // Simple copy
    await copyFile(sourcePath, targetPath);
    return;
  }

  // Read, rewrite links, write
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- sourcePath is validated
  let content = await readFile(sourcePath, 'utf-8');

  // Rewrite markdown links to work in flat structure
  content = rewriteMarkdownLinks(content, (href, text) => {
    // Keep external URLs and anchors unchanged
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:') || href.startsWith('#')) {
      return rewriteHref(href);
    }

    // Split anchor from path
    const [linkPath, anchor] = href.split('#');
    if (!linkPath || linkPath === '') {
      // Pure anchor link - keep as is
      return rewriteHref(href);
    }

    // Resolve old link target (where it currently is)
    // Normalize to handle path separator differences
    const resolvedTarget = resolve(dirname(sourcePath), linkPath);
    const normalizedTarget = toForwardSlash(resolvedTarget);

    // Check if this link targets an excluded file
    if (excludeCtx?.excludedFiles.has(normalizedTarget)) {
      const info = excludeCtx.ruleMap.get(normalizedTarget);
      const rule = info?.rule ?? info?.defaultRule ?? {};
      const template = rule.template ?? DEFAULT_STRIP_TEMPLATE;
      const context = {
        link: {
          text,
          uri: href,
          fileName: basename(resolvedTarget),
          filePath: toForwardSlash(relative(excludeCtx.skillRoot, resolvedTarget)),
        },
        skill: { name: excludeCtx.skillName },
      };
      return replaceEntire(renderTemplate(template, context));
    }

    // Look up where this file will be in the flat structure
    // pathMap keys are also normalized, so this should match
    const newLinkTarget = pathMap.get(normalizedTarget);
    if (newLinkTarget === undefined) {
      // Link points to file not in package (external link already warned about)
      // Keep original href (will be broken, but user was warned)
      return rewriteHref(href);
    }

    // In flat structure, all files are at same level, so just use basename
    let relativePath = relative(dirname(targetPath), newLinkTarget);

    // Clean up ./ prefix (relative() returns ./file when in same directory)
    const normalizedRelPath = toForwardSlash(relativePath);
    if (normalizedRelPath.startsWith('./')) {
      relativePath = normalizedRelPath.slice(2);
    } else if (normalizedRelPath === '.') {
      // Same file (shouldn't happen but handle gracefully)
      relativePath = basename(newLinkTarget);
    } else {
      relativePath = normalizedRelPath;
    }

    // Reconstruct with anchor if present
    const newHref = anchor ? `${relativePath}#${anchor}` : relativePath;

    // Use forward slashes for consistency
    return rewriteHref(toForwardSlash(newHref));
  });

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Target path is constructed from validated paths
  await writeFile(targetPath, content, 'utf-8');
}

/**
 * Result of a link transform operation.
 * - 'rewrite-href': Replace the href but keep the link structure
 * - 'replace-entire': Replace the entire link markup with a plain text replacement
 */
type LinkTransformResult =
  | { type: 'rewrite-href'; href: string }
  | { type: 'replace-entire'; replacement: string };

/** Create a rewrite-href transform result */
function rewriteHref(href: string): LinkTransformResult {
  return { type: 'rewrite-href', href };
}

/** Create a replace-entire transform result */
function replaceEntire(replacement: string): LinkTransformResult {
  return { type: REPLACE_ENTIRE, replacement };
}

/**
 * Transform function for link rewriting.
 * Receives the href and link text, returns either a new href or a full replacement.
 */
type LinkTransform = (href: string, text: string) => LinkTransformResult;

/**
 * Rewrite markdown links using a transform function
 *
 * Handles both inline links [text](href) and reference links [ref]: href.
 * The transform can either rewrite the href or replace the entire link.
 *
 * @param content - Markdown content
 * @param transform - Function to transform each link
 * @returns Modified markdown content
 */
function rewriteMarkdownLinks(
  content: string,
  transform: LinkTransform
): string {
  // Rewrite inline links: [text](href)
  // Input is from controlled markdown files, not untrusted user input
  let result = content.replaceAll(
    // eslint-disable-next-line sonarjs/slow-regex -- Controlled markdown input
    /\[((?:[^\]])*?)\]\(((?:[^)])*?)\)/g,
    (_match, ...args) => {
      const text = String(args[0]);
      const href = String(args[1]);
      const transformResult = transform(href, text);
      if (transformResult.type === REPLACE_ENTIRE) {
        return transformResult.replacement;
      }
      return `[${text}](${transformResult.href})`;
    }
  );

  // Rewrite reference-style link definitions: [ref]: href
  // Input is from controlled markdown files, not untrusted user input
  result = result.replaceAll(
    // eslint-disable-next-line sonarjs/slow-regex -- Controlled markdown input
    /^\[((?:[^\]])*?)\]:\s*(.+)$/gm,
    (_match, ...args) => {
      const ref = String(args[0]);
      const href = String(args[1]);
      const transformResult = transform(href.trim(), ref);
      if (transformResult.type === REPLACE_ENTIRE) {
        return transformResult.replacement;
      }
      return `[${ref}]: ${transformResult.href}`;
    }
  );

  return result;
}

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

/**
 * Find the package root or fall back to skill's directory
 *
 * Used for package boundary detection - if no package.json found,
 * uses skill's directory as the boundary (useful for tests).
 *
 * @param skillPath - Path to SKILL.md
 * @returns Package root directory or skill's directory
 */
function findPackageRootOrFallback(skillPath: string): string {
  return findPackageRoot(skillPath, true);
}

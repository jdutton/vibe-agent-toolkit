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
import { toForwardSlash } from '@vibe-agent-toolkit/utils';

const PACKAGE_JSON_FILENAME = 'package.json';

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
    basePath = dirname(skillPath),
  } = options;

  // 1. Parse SKILL.md frontmatter and links
  const parseResult = await parseMarkdown(skillPath);
  const skillMetadata = extractSkillMetadata(parseResult, skillPath);

  // 2. Find package boundary (to prevent collecting files from other packages)
  // If no package.json found, use skill's directory as boundary (for tests)
  const packageRoot = findPackageRootOrFallback(skillPath);

  // 3. Collect all linked resources recursively (only within package boundary)
  const linkedFiles = await collectLinkedResources(
    skillPath,
    basePath,
    packageRoot,
    new Set()
  );

  // 3. Calculate common ancestor of all files (for proper relative path calculation)
  const allFiles = [skillPath, ...linkedFiles];
  const effectiveBasePath = findCommonAncestor(allFiles);

  // 4. Determine output path
  const outputPath = options.outputPath ??
    getDefaultSkillOutputPath(skillPath, skillMetadata.name);

  // 5. Copy SKILL.md and all linked files (flat structure)
  await copySkillResources(
    skillPath,
    linkedFiles,
    outputPath,
    rewriteLinks
  );

  // 6. Generate distribution artifacts
  const artifacts = await generatePackageArtifacts(
    outputPath,
    skillMetadata,
    formats
  );

  // Get relative paths for result
  const relativeLinkedFiles = linkedFiles.map(f =>
    toForwardSlash(relative(effectiveBasePath, f))
  );

  return {
    outputPath,
    skill: skillMetadata,
    files: {
      root: 'SKILL.md',
      dependencies: relativeLinkedFiles,
    },
    artifacts,
  };
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
 * Process a linked file and recursively collect its dependencies
 *
 * Validates the file exists and is within package boundary, then recursively collects
 * all files linked from it.
 *
 * @param resolvedPath - Absolute path to the linked file
 * @param href - Original href from markdown (for warning messages)
 * @param packageRoot - Package root directory (boundary for file collection)
 * @param basePath - Base path for resolving relative links
 * @param visited - Set of already visited files (prevents loops)
 * @param linkedFiles - Array to push results into
 */
async function processAndCollectLinkedFile(
  resolvedPath: string,
  href: string,
  packageRoot: string,
  basePath: string,
  visited: Set<string>,
  linkedFiles: string[]
): Promise<void> {
  // Check if file exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path constructed from parsed markdown links
  if (!existsSync(resolvedPath)) {
    console.warn(`Warning: Linked file not found: ${href} (resolved to ${resolvedPath})`);
    return;
  }

  // Check package boundary
  const normalizedResolved = toForwardSlash(resolvedPath);
  const normalizedPackageRoot = toForwardSlash(packageRoot);
  if (!normalizedResolved.startsWith(normalizedPackageRoot)) {
    console.warn(
      `Warning: Skipping external link outside package boundary: ${href}\n` +
      `  Resolved to: ${resolvedPath}\n` +
      `  Package root: ${packageRoot}\n` +
      `  External links are not included in skill packages.`
    );
    return;
  }

  linkedFiles.push(resolvedPath);

  // Recursively collect from this file
  const transitive = await collectLinkedResources(
    resolvedPath,
    basePath,
    packageRoot,
    visited
  );
  linkedFiles.push(...transitive);
}

/**
 * Extract reference-style link definitions from markdown content
 *
 * Parses markdown content to find reference-style link definitions like: [ref]: url
 * These are not included in the AST parser's link extraction.
 *
 * @param content - Markdown content
 * @param markdownPath - Path to markdown file (for relative link resolution)
 * @param packageRoot - Package root directory (boundary for file collection)
 * @param basePath - Base path for resolving relative links
 * @param visited - Set of already visited files (prevents loops)
 * @returns Array of absolute paths to linked files
 */
async function extractReferenceStyleLinks(
  content: string,
  markdownPath: string,
  packageRoot: string,
  basePath: string,
  visited: Set<string>
): Promise<string[]> {
  const linkedFiles: string[] = [];
  // eslint-disable-next-line sonarjs/slow-regex -- Controlled markdown input with trusted content
  const refLinkDefRegex = /^\[([^\]]+)\]:\s*(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = refLinkDefRegex.exec(content)) !== null) {
    const href = match[2]?.trim();
    if (!href) {
      continue;
    }

    // Skip external URLs
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
      continue;
    }

    // Remove anchor fragments
    const hrefWithoutAnchor = href.split('#')[0] ?? href;
    if (hrefWithoutAnchor === '') {
      continue;
    }

    // Resolve relative to the markdown file's directory
    const resolvedPath = resolve(dirname(markdownPath), hrefWithoutAnchor);

    // Only include .md files
    if (!resolvedPath.endsWith('.md')) {
      continue;
    }

    await processAndCollectLinkedFile(
      resolvedPath,
      href,
      packageRoot,
      basePath,
      visited,
      linkedFiles
    );
  }

  return linkedFiles;
}

/**
 * Collect all linked resources from SKILL.md recursively
 *
 * Follows local file links to build a complete dependency graph.
 * Prevents infinite loops by tracking visited files.
 * Only collects files within the package boundary (prevents pulling in entire monorepo).
 *
 * @param markdownPath - Current markdown file to process
 * @param basePath - Base path for resolving relative links
 * @param packageRoot - Package root directory (boundary for file collection)
 * @param visited - Set of already visited files (prevents loops)
 * @returns Array of absolute paths to all linked files within package
 */
async function collectLinkedResources(
  markdownPath: string,
  basePath: string,
  packageRoot: string,
  visited: Set<string>
): Promise<string[]> {
  // Prevent infinite loops
  const normalizedPath = resolve(markdownPath);
  if (visited.has(normalizedPath)) {
    return [];
  }
  visited.add(normalizedPath);

  // Parse markdown to extract links
  const parseResult = await parseMarkdown(markdownPath);
  const linkedFiles: string[] = [];

  // Extract reference-style link definitions: [ref]: url
  // These are not included in parseResult.links, so we need to parse them separately
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- markdownPath validated by caller
  const content = await readFile(markdownPath, 'utf-8');
  const refStyleLinks = await extractReferenceStyleLinks(
    content,
    markdownPath,
    packageRoot,
    basePath,
    visited
  );
  linkedFiles.push(...refStyleLinks);

  // Process inline links from parseResult
  for (const link of parseResult.links) {
    // Skip non-local links
    if (link.type !== 'local_file') {
      continue;
    }

    // Remove anchor fragments (#...)
    const hrefWithoutAnchor = link.href.split('#')[0] ?? link.href;
    if (hrefWithoutAnchor === '') {
      continue; // Pure anchor link
    }

    // Resolve relative to the markdown file's directory
    const resolvedPath = resolve(dirname(markdownPath), hrefWithoutAnchor);

    // Only include .md files
    if (!resolvedPath.endsWith('.md')) {
      continue;
    }

    await processAndCollectLinkedFile(
      resolvedPath,
      link.href,
      packageRoot,
      basePath,
      visited,
      linkedFiles
    );
  }

  // Deduplicate
  return [...new Set(linkedFiles)];
}

/**
 * Copy SKILL.md and linked files to output directory
 *
 * Creates a FLAT structure with all files at the root level.
 * Rewriteslinks to work in the flattened structure.
 *
 * @param skillPath - Path to SKILL.md
 * @param linkedFiles - All linked files to copy
 * @param outputPath - Destination directory
 * @param rewriteLinks - Whether to rewrite links
 */
async function copySkillResources(
  skillPath: string,
  linkedFiles: string[],
  outputPath: string,
  rewriteLinks: boolean
): Promise<void> {
  // Ensure output directory exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Output path is validated
  await mkdir(outputPath, { recursive: true });

  // Build a map of original paths to flattened paths
  // Normalize all keys for consistent lookup (handles path separator differences)
  const pathMap = new Map<string, string>();
  pathMap.set(toForwardSlash(skillPath), join(outputPath, 'SKILL.md'));

  // Map all linked files to flat structure (using basenames)
  // Check for collisions
  for (const linkedFile of linkedFiles) {
    const filename = basename(linkedFile);
    const targetPath = join(outputPath, filename);

    // Check for filename collisions
    const existingSource = [...pathMap.entries()].find(
      ([_src, target]) => target === targetPath
    )?.[0];

    if (existingSource !== undefined && existingSource !== linkedFile) {
      throw new Error(
        `Filename collision detected when flattening skill structure:\n` +
        `  File 1: ${existingSource}\n` +
        `  File 2: ${linkedFile}\n` +
        `  Both would be copied to: ${filename}\n` +
        `  Cannot flatten structure with duplicate filenames.`
      );
    }

    pathMap.set(toForwardSlash(linkedFile), targetPath);
  }

  // Copy SKILL.md
  await copyAndRewriteFile(
    skillPath,
    join(outputPath, 'SKILL.md'),
    pathMap,
    rewriteLinks
  );

  // Copy all linked files to flat structure
  for (const linkedFile of linkedFiles) {
    const targetPath = pathMap.get(toForwardSlash(linkedFile));
    if (targetPath === undefined) {
      continue; // Should never happen, but satisfy type checker
    }

    await copyAndRewriteFile(
      linkedFile,
      targetPath,
      pathMap,
      rewriteLinks
    );
  }
}

/**
 * Copy a markdown file, optionally rewriting links
 *
 * If rewriteLinks is true, adjusts relative links to work from new flat location.
 *
 * @param sourcePath - Source file absolute path
 * @param targetPath - Target file absolute path
 * @param pathMap - Map of source paths to target paths (for flat structure)
 * @param rewriteLinks - Whether to rewrite links
 */
async function copyAndRewriteFile(
  sourcePath: string,
  targetPath: string,
  pathMap: Map<string, string>,
  rewriteLinks: boolean
): Promise<void> {
  // Ensure target directory exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetPath is constructed from validated paths
  await mkdir(dirname(targetPath), { recursive: true });

  if (!rewriteLinks) {
    // Simple copy
    await copyFile(sourcePath, targetPath);
    return;
  }

  // Read, rewrite links, write
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- sourcePath is validated
  let content = await readFile(sourcePath, 'utf-8');

  // Rewrite markdown links to work in flat structure
  content = rewriteMarkdownLinks(content, (href) => {
    // Keep external URLs and anchors unchanged
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:') || href.startsWith('#')) {
      return href;
    }

    // Split anchor from path
    const [path, anchor] = href.split('#');
    if (!path || path === '') {
      // Pure anchor link - keep as is
      return href;
    }

    // Resolve old link target (where it currently is)
    // Normalize to handle path separator differences
    const oldLinkTarget = toForwardSlash(resolve(dirname(sourcePath), path));

    // Look up where this file will be in the flat structure
    // pathMap keys are also normalized, so this should match
    const newLinkTarget = pathMap.get(oldLinkTarget);
    if (newLinkTarget === undefined) {
      // Link points to file not in package (external link already warned about)
      // Keep original href (will be broken, but user was warned)
      return href;
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
    return toForwardSlash(newHref);
  });

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Target path is constructed from validated paths
  await writeFile(targetPath, content, 'utf-8');
}

/**
 * Rewrite markdown links using a transform function
 *
 * Handles both inline links [text](href) and reference links [text][ref].
 *
 * @param content - Markdown content
 * @param transform - Function to transform each href
 * @returns Modified markdown content
 */
function rewriteMarkdownLinks(
  content: string,
  transform: (href: string) => string
): string {
  // Rewrite inline links: [text](href)
  // Input is from controlled markdown files, not untrusted user input
  let result = content.replaceAll(
    // eslint-disable-next-line sonarjs/slow-regex -- Controlled markdown input
    /\[((?:[^\]])*?)\]\(((?:[^)])*?)\)/g,
    (_match, ...args) => {
      const text = String(args[0]);
      const href = String(args[1]);
      const newHref = transform(href);
      return `[${text}](${newHref})`;
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
      const newHref = transform(href.trim());
      return `[${ref}]: ${newHref}`;
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

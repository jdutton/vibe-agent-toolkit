/**
 * Package a skill for distribution
 *
 * Creates distributable artifacts (directory, ZIP, npm) from a SKILL.md file
 */

import { existsSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';

import { packageSkill, type PackageSkillOptions } from '@vibe-agent-toolkit/agent-skills';
import { parseMarkdown, type ParseResult } from '@vibe-agent-toolkit/resources';
import { Command } from 'commander';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';

export interface SkillsPackageCommandOptions {
  output: string;
  formats?: string;
  'no-rewrite-links'?: boolean;
  'base-path'?: string;
  dryRun?: boolean;
  debug?: boolean;
}

export function createPackageCommand(): Command {
  const command = new Command('package');

  command
    .description('Package a skill for distribution (creates directory + ZIP artifacts)')
    .argument('<skill-path>', 'Path to SKILL.md file')
    .requiredOption('-o, --output <path>', 'Output directory for packaged skill')
    .option(
      '-f, --formats <formats>',
      'Package formats (comma-separated: directory,zip,npm,marketplace)',
      'directory,zip'
    )
    .option('--no-rewrite-links', 'Skip rewriting relative links in copied files')
    .option('-b, --base-path <path>', 'Base path for resolving relative links (default: dirname of SKILL.md)')
    .option('--dry-run', 'Preview packaging without creating files')
    .option('--debug', 'Enable debug logging')
    .action(packageCommand)
    .addHelpText(
      'after',
      `
Description:
  Packages a SKILL.md file and all linked resources into distributable
  formats. Recursively collects all markdown files linked from SKILL.md,
  rewrites links to maintain correctness after relocation, and creates
  artifacts for distribution.

  Default formats: directory (ready-to-use) + ZIP (single file)

  REQUIRED: --output flag must specify where to create the package

Output:
  - outputPath: Where the packaged skill was created
  - skill.name: Skill name (from frontmatter or H1 title)
  - files.dependencies: List of files included in package
  - artifacts: Map of format → file path
  - dryRun: true if --dry-run was used (no files created)

Exit Codes:
  0 - Packaging successful (or dry-run preview)
  1 - Invalid skill path or packaging error
  2 - System error

Examples:
  $ vat skills package SKILL.md -o dist/my-skill
  $ vat skills package SKILL.md -o /tmp/skill --dry-run
  $ vat skills package SKILL.md -o dist -f zip,npm
`
    );

  return command;
}

/**
 * Recursively collect linked markdown files
 */
async function collectLinkedFiles(
  markdownPath: string,
  basePath: string,
  visited: Set<string>
): Promise<string[]> {
  const normalizedPath = resolve(markdownPath);
  if (visited.has(normalizedPath)) {
    return [];
  }
  visited.add(normalizedPath);

  const parseResult = await parseMarkdown(markdownPath);
  const linkedFiles: string[] = [];

  for (const link of parseResult.links) {
    if (link.type !== 'local_file') continue;

    const hrefWithoutAnchor = link.href.split('#')[0] ?? link.href;
    if (hrefWithoutAnchor === '') continue;

    const resolvedPath = resolve(dirname(markdownPath), hrefWithoutAnchor);

    // Only include markdown files (no basePath filtering - collect all valid linked files)
    if (!resolvedPath.endsWith('.md')) continue;

    // Skip missing files
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path resolved from validated markdown links
    if (!existsSync(resolvedPath)) continue;

    linkedFiles.push(resolvedPath);

    // Recursively collect from this file
    const transitive = await collectLinkedFiles(resolvedPath, basePath, visited);
    linkedFiles.push(...transitive);
  }

  // Deduplicate
  return [...new Set(linkedFiles)];
}

/**
 * Extract skill name from parse result
 */
function extractSkillName(parseResult: ParseResult): string {
  if (parseResult.frontmatter?.['name']) {
    return parseResult.frontmatter['name'] as string;
  }

  // Try to extract H1
  const lines = parseResult.content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      return trimmed.slice(2).trim();
    }
  }

  return 'unknown';
}

/**
 * Calculate estimated ZIP size for files
 */
function calculateZipSize(skillPath: string, linkedFiles: string[]): number {
  let totalSize = 0;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- User-provided path, validated
  totalSize += statSync(skillPath).size;

  for (const file of linkedFiles) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Collected from validated markdown links
    if (existsSync(file)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Collected from validated markdown links
      totalSize += statSync(file).size;
    }
  }

  // Rough estimate: 60% compression for markdown
  return Math.round((totalSize * 0.6) / 1024);
}

/**
 * Output dry-run results as YAML
 */
function outputDryRunYaml(
  skillName: string,
  outputPath: string,
  fileCount: number,
  formats: string[],
  duration: number
): void {
  process.stdout.write('---\n');
  process.stdout.write(`status: success\n`);
  process.stdout.write(`dryRun: true\n`);
  process.stdout.write(`skill: ${skillName}\n`);
  process.stdout.write(`outputPath: ${outputPath}\n`);
  process.stdout.write(`filesPackaged: ${fileCount}\n`);
  process.stdout.write(`formats:\n`);
  for (const format of formats) {
    process.stdout.write(`  - ${format}\n`);
  }
  process.stdout.write(`duration: ${duration}ms\n`);
}

/**
 * Perform dry-run preview of packaging operation
 */
async function performDryRun(
  skillPath: string,
  options: SkillsPackageCommandOptions,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const startTime = Date.now();

  // Validate skill path exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- User-provided CLI argument, validated
  if (!existsSync(skillPath)) {
    throw new Error(`SKILL.md not found: ${skillPath}`);
  }

  logger.info(`🔍 Dry-run: Analyzing skill packaging...`);
  logger.info(`   Source: ${skillPath}`);
  logger.info(`   Output: ${options.output}`);

  // Parse SKILL.md and extract metadata
  const parseResult = await parseMarkdown(skillPath);
  const skillName = extractSkillName(parseResult);
  logger.info(`   Skill: ${skillName}`);

  // Collect linked files (recursively)
  const basePath = options['base-path'] ?? dirname(skillPath);
  const linkedFiles = await collectLinkedFiles(skillPath, basePath, new Set());

  logger.info(`\n📁 Files to be packaged:`);
  logger.info(`   - SKILL.md (root)`);
  for (const file of linkedFiles) {
    const relPath = relative(basePath, file);
    logger.info(`   - ${relPath}`);
  }
  logger.info(`\n   Total: ${linkedFiles.length + 1} files`);

  // Parse and display formats
  const formats = options.formats?.split(',').map(f => f.trim()) ?? ['directory', 'zip'];
  logger.info(`\n📦 Formats to create:`);
  for (const format of formats) {
    logger.info(`   - ${format}`);
  }

  // Estimate ZIP size if needed
  if (formats.includes('zip')) {
    const estimatedZipSize = calculateZipSize(skillPath, linkedFiles);
    logger.info(`\n📊 Estimated ZIP size: ~${estimatedZipSize}KB`);
  }

  const duration = Date.now() - startTime;

  // Output YAML results
  outputDryRunYaml(skillName, options.output, linkedFiles.length + 1, formats, duration);

  logger.info(`\n✅ Dry-run complete (no files created)`);
  logger.info(`   Run without --dry-run to create the package`);
}

async function packageCommand(
  skillPath: string,
  options: SkillsPackageCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    logger.info(`📦 Packaging skill: ${skillPath}`);

    // Parse formats
    const formats = options.formats
      ?.split(',')
      .map(f => f.trim() as 'directory' | 'zip' | 'npm' | 'marketplace') ?? ['directory', 'zip'];

    // Build package options
    const packageOptions: PackageSkillOptions = {
      formats,
      rewriteLinks: options['no-rewrite-links'] !== true,
      outputPath: options.output,
    };

    if (options['base-path']) {
      packageOptions.basePath = options['base-path'];
    }

    // Handle dry-run mode
    if (options.dryRun) {
      await performDryRun(skillPath, options, logger);
      process.exit(0);
    }

    // Package the skill
    const result = await packageSkill(skillPath, packageOptions);

    const duration = Date.now() - startTime;

    // Output YAML to stdout
    process.stdout.write('---\n');
    process.stdout.write(`status: success\n`);
    process.stdout.write(`skill: ${result.skill.name}\n`);
    process.stdout.write(`version: ${result.skill.version ?? 'unspecified'}\n`);
    process.stdout.write(`outputPath: ${result.outputPath}\n`);
    process.stdout.write(`filesPackaged: ${result.files.dependencies.length + 1}\n`);

    if (result.artifacts) {
      process.stdout.write(`artifacts:\n`);
      for (const [format, path] of Object.entries(result.artifacts)) {
        process.stdout.write(`  ${format}: ${path}\n`);
      }
    }

    process.stdout.write(`duration: ${duration}ms\n`);

    logger.info(`✅ Packaged skill: ${result.skill.name}`);
    logger.info(`   Output: ${result.outputPath}`);

    if (result.artifacts?.['zip']) {
      logger.info(`   ZIP: ${basename(result.artifacts['zip'])}`);
    }

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsPackage');
  }
}

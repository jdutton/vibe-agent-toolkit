/**
 * Package a skill for distribution
 *
 * Creates distributable artifacts (directory, ZIP, npm) from a SKILL.md file
 */

import { existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';


import type { SeverityCounts } from '@vibe-agent-toolkit/agent-schema';
import {
  packageSkill,
  validateSkill,
  ZipSizeLimitError,
  type PackageSkillOptions,
  type PackagingTarget,
  type ValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import { parseMarkdown, type ParseResult } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';
import * as yaml from 'yaml';

import { handleCommandError, handleValidationGateFailure } from '../../utils/command-error.js';
import { formatIssueLines, formatIssueSetHeading } from '../../utils/issue-rendering.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';
import { requireProjectRoot } from '../../utils/project-root-policy.js';

/** Default packaging target */
const DEFAULT_TARGET: PackagingTarget = 'claude-code';
/** Valid packaging targets */
const VALID_TARGETS: readonly PackagingTarget[] = ['claude-code', 'claude-web'];

export interface SkillsPackageCommandOptions {
  output: string;
  formats?: string;
  rewriteLinks?: boolean; // Commander negates this when --no-rewrite-links is passed; absent = true
  basePath?: string; // Commander camelCases -b, --base-path <path>; never a 'base-path' key
  dryRun?: boolean;
  debug?: boolean;
  target?: string;
}

/**
 * Whether packaging should rewrite relative links in copied files.
 *
 * Commander represents a `--no-x` boolean as the POSITIVE key `x` — defaulted to
 * `true`, set to `false` only when the negated flag is passed; it never emits a
 * `no-x` (or `noX`) key. This site used to read `options['no-rewrite-links']`,
 * typed against an interface that declared that literal kebab key, so the
 * compiler validated a read that could only ever be `undefined`:
 * `--no-rewrite-links` was a silent no-op and links were always rewritten.
 */
export function resolveRewriteLinks(
  options: Pick<SkillsPackageCommandOptions, 'rewriteLinks'>
): boolean {
  return options.rewriteLinks !== false;
}

/**
 * The base directory relative links resolve against, defaulting to the SKILL.md
 * directory when `--base-path` is not given.
 *
 * Same class of defect as above, in its value-carrying form: Commander camelCases
 * `-b, --base-path <path>` to `basePath`, so the old `options['base-path']` reads
 * were always `undefined` and the flag was ignored — the base always fell back to
 * `dirname(skillPath)`.
 */
export function resolveBasePath(
  options: Pick<SkillsPackageCommandOptions, 'basePath'>,
  skillPath: string
): string {
  return options.basePath ?? dirname(skillPath);
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
    .option(
      '--target <target>',
      'Packaging target: claude-code (default, resources/ dir) or claude-web (references/, scripts/, assets/ dirs for Claude.ai upload)',
      DEFAULT_TARGET
    )
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

Requirements:
  projectRoot: required (errors if no vibe-agent-toolkit.config.yaml or .git/ ancestor)
  config:      required file with skills.* fields populated

  See docs/concepts/roots-and-config.md for terminology.

Examples:
  $ vat skills package SKILL.md -o dist/my-skill
  $ vat skills package SKILL.md -o /tmp/skill --dry-run
  $ vat skills package SKILL.md -o dist -f zip,npm
`
    );

  return command;
}

/**
 * Validate skill, render every finding, and exit if any is an error.
 *
 * Returns the result so the caller can publish its verdict and per-severity
 * counts — the verdict of the validation actually run, not a literal.
 */
async function validateSkillOrExit(
  skillPath: string,
  basePath: string,
  logger: ReturnType<typeof createLogger>
): Promise<ValidationResult> {
  logger.info(`\n🔍 Validating skill...`);
  const validationResult = await validateSkill({
    skillPath,
    rootDir: basePath,
  });

  for (const line of formatSkillValidationLines(validationResult)) {
    logger.info(line);
  }

  if (validationResult.status === 'error') {
    // The findings above went to stderr only; without this the command exited 1
    // having written zero bytes of the documented stdout summary.
    handleValidationGateFailure(skillPath, validationResult.issues);
  }

  return validationResult;
}

/**
 * The header a `skills package` run publishes: the verdict of the validation it
 * actually ran, with that validation's distribution beside it.
 *
 * `status` used to be the literal `success`, printed next to counts drawn from
 * the very validation whose verdict it contradicted — so a skill `vat skills
 * build` reports as `warning` was reported here as `success`. Two lanes, one
 * skill, two answers. The counts alone did not close it: a consumer reading
 * `status` (the field the docs tell them to read) never saw the disagreement.
 */
export function buildPackageHeader(validation: ValidationResult): {
  status: 'success' | 'warning' | 'error';
  issueCounts: SeverityCounts;
} {
  return { status: validation.status, issueCounts: validation.issueCounts };
}

/**
 * Render the validation report: a headline that names what was found, then every
 * issue labelled with its own severity.
 *
 * Two silent drops used to live here. The renderer filtered to `error` and
 * `warning` only, so every `info` finding vanished; and the caller only invoked
 * it for `status === 'error'`, so a warning-severity result printed a bare
 * `✅ Validation passed` — the shared collapse resolves warnings to a
 * non-blocking status, which is exactly the case that got swallowed.
 */
/** One glyph per status value — total, so a new status cannot fall through to a nicer one. */
const SKILL_VALIDATION_GLYPHS: Record<ValidationResult['status'], string> = {
  error: '❌',
  warning: '⚠️ ',
  success: 'ℹ️ ',
};

export function formatSkillValidationLines(validationResult: ValidationResult): string[] {
  const { issues, status } = validationResult;
  if (issues.length === 0) {
    return ['✅ Validation passed — no findings'];
  }

  const glyph = SKILL_VALIDATION_GLYPHS[status];
  const headline = status === 'error'
    ? `\n${glyph} Skill validation failed — ${formatIssueSetHeading(issues)}`
    : `\n${glyph} Validation passed with findings — ${formatIssueSetHeading(issues)}`;

  const lines = [headline, `   Summary: ${validationResult.summary}\n`];
  for (const issue of issues) {
    lines.push(...formatIssueLines(issue, '  '));
  }
  lines.push('');
  return lines;
}

/**
 * Recursively collect linked markdown files
 */
async function collectLinkedFiles(
  markdownPath: string,
  basePath: string,
  visited: Set<string>
): Promise<string[]> {
  const normalizedPath = safePath.resolve(markdownPath);
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

    const resolvedPath = safePath.resolve(dirname(markdownPath), hrefWithoutAnchor);

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
 * Write the status + per-severity counts block that opens the summary.
 *
 * `success` here means the packaging step succeeded and nothing BLOCKED it —
 * not that validation was silent. Without the distribution beside it, a
 * consumer cannot tell those two apart, and the reassuring reading is the one
 * they will take.
 */
function writePackageHeader(validation: ValidationResult): void {
  // Serialized from a real object rather than hand-spelled lines: the property
  // has to be visible as a property (to a reader and to the repo's severity-counts
  // ratchet, which scans source for a counts block), and yaml.stringify cannot
  // get the indentation wrong.
  process.stdout.write(
    yaml.stringify(buildPackageHeader(validation), { indent: 2, lineWidth: 0 }),
  );
}

/**
 * Output dry-run results as YAML
 */
function outputDryRunYaml(
  skillName: string,
  outputPath: string,
  fileCount: number,
  formats: string[],
  duration: number,
  validation: ValidationResult
): void {
  process.stdout.write('---\n');
  writePackageHeader(validation);
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

  // VALIDATE FIRST - shift left to catch errors early
  const validationResult = await validateSkillOrExit(
    skillPath,
    resolveBasePath(options, skillPath),
    logger,
  );

  // Parse SKILL.md and extract metadata
  const parseResult = await parseMarkdown(skillPath);
  const skillName = extractSkillName(parseResult);
  logger.info(`   Skill: ${skillName}`);

  // Collect linked files (recursively)
  const basePath = resolveBasePath(options, skillPath);
  const linkedFiles = await collectLinkedFiles(skillPath, basePath, new Set());

  logger.info(`\n📁 Files to be packaged:`);
  logger.info(`   - SKILL.md (root)`);
  for (const file of linkedFiles) {
    const relPath = safePath.relative(basePath, file);
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
  outputDryRunYaml(
    skillName,
    options.output,
    linkedFiles.length + 1,
    formats,
    duration,
    validationResult,
  );

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
    // Spec §7: `vat skills package` requires a projectRoot — fails fast at
    // the CLI boundary if no config or git ancestor exists.
    requireProjectRoot(process.cwd(), 'vat skills package');

    logger.info(`📦 Packaging skill: ${skillPath}`);

    // Validate --target option
    const rawTarget = options.target ?? DEFAULT_TARGET;
    if (!VALID_TARGETS.includes(rawTarget as PackagingTarget)) {
      throw new Error(
        `Invalid --target value: "${rawTarget}". Valid targets are: ${VALID_TARGETS.join(', ')}`
      );
    }
    const target = rawTarget as PackagingTarget;

    // Parse formats
    const formats = options.formats
      ?.split(',')
      .map(f => f.trim() as 'directory' | 'zip' | 'npm' | 'marketplace') ?? ['directory', 'zip'];

    // Build package options
    const packageOptions: PackageSkillOptions = {
      formats,
      rewriteLinks: resolveRewriteLinks(options),
      outputPath: options.output,
      target,
    };

    // Only set when explicitly supplied — packageSkill() owns the fallback for
    // this field, so an unconditional resolveBasePath() here would change it.
    if (options.basePath) {
      packageOptions.basePath = options.basePath;
    }

    // Handle dry-run mode
    if (options.dryRun) {
      await performDryRun(skillPath, options, logger);
      process.exit(0);
    }

    // VALIDATE FIRST - shift left to catch errors early
    const validationResult = await validateSkillOrExit(
      skillPath,
      resolveBasePath(options, skillPath),
      logger,
    );
    logger.info('');

    // Package the skill
    const result = await packageSkill(skillPath, packageOptions);

    const duration = Date.now() - startTime;

    // Output YAML to stdout
    process.stdout.write('---\n');
    writePackageHeader(validationResult);
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
    if (error instanceof ZipSizeLimitError) {
      const duration = Date.now() - startTime;
      logger.error(`Package failed: ${error.message}`);
      writeYamlOutput({ status: 'error', error: error.message, duration: `${duration}ms` });
      process.exit(1);
    }
    handleCommandError(error, logger, startTime, 'SkillsPackage');
  }
}

/**
 * Package a skill for distribution
 *
 * Creates distributable artifacts (directory, ZIP, npm) from a SKILL.md file
 */

import { existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';


import {
  isSkillPackagingInputError,
  packageSkill,
  validateSkill,
  ZipSizeLimitError,
  type PackageSkillOptions,
  type PackagingTarget,
  type ValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import { parseFileCached, type ParseResult } from '@vibe-agent-toolkit/resources';
import { buildReport, toFindings, type Gate, type Report, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { findProjectRoot, issueLocation, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { CommandRefusalError, errorMessageOf, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { formatIssueLines, formatIssueSetHeading } from '../../utils/issue-rendering.js';
import { createLogger } from '../../utils/logger.js';
import { readInputFile, requireProjectRoot } from '../../utils/project-root-policy.js';
import { resolveSkillPath } from '../skill/review.js';

import { packagingFailedIssue } from './build.js';
import type { SkillsPackageData } from './package-schema.js';

/** Default packaging target */
const DEFAULT_TARGET: PackagingTarget = 'claude-code';
/** Valid packaging targets */
const VALID_TARGETS: readonly PackagingTarget[] = ['claude-code', 'claude-web'];
/** One format `packageSkill` can produce. */
type PackageFormat = NonNullable<PackageSkillOptions['formats']>[number];
/** Every `--formats` value, in the order the help text lists them. */
const VALID_FORMATS: readonly PackageFormat[] = ['directory', 'zip', 'npm', 'marketplace'];
/** The formats produced when `--formats` is not given. */
const DEFAULT_FORMATS: readonly PackageFormat[] = ['directory', 'zip'];

export interface SkillsPackageCommandOptions {
  output: string;
  formats?: string;
  rewriteLinks?: boolean; // Commander negates this when --no-rewrite-links is passed; absent = true
  basePath?: string; // Commander camelCases -b, --base-path <path>; never a 'base-path' key
  dryRun?: boolean;
  debug?: boolean;
  target?: string;
  force?: boolean;
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
    .argument('<skill-path>', 'Path to the SKILL.md file (or the skill directory holding it)')
    .requiredOption('-o, --output <path>', 'Output directory for packaged skill')
    .option(
      '-f, --formats <formats>',
      `Package formats (comma-separated: ${VALID_FORMATS.join(',')}; an unknown name is refused)`,
      DEFAULT_FORMATS.join(',')
    )
    .option('--no-rewrite-links', 'Skip rewriting relative links in copied files')
    .option('-b, --base-path <path>', 'Base path for resolving relative links (default: dirname of SKILL.md)')
    .option('--dry-run', 'Preview packaging without creating files: the real run stopped before its first write, so what it would refuse before writing is refused here too')
    .option('--force', 'Replace a previous package: remove and rebuild --output, overwrite a <output>.zip / <name>.marketplace.json file beside it (a directory there is not removed); without it, an --output that holds anything is refused')
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

  VAT never deletes what it did not produce. An --output that already holds
  anything — a non-empty directory, a file, or (with the zip / marketplace
  formats) the <output>.zip or <name>.marketplace.json beside it — is refused
  (USAGE_INVALID) and left exactly as it was, unless --force says it is a
  previous package to replace: --force removes the --output and overwrites
  a <output>.zip / <name>.marketplace.json FILE beside it, but never removes
  a directory standing in an archive's place (that write ends RUN_INCOMPLETE).
  --dry-run runs the same check. An empty directory is used as-is. An --output
  that is, or contains, the SKILL.md or a file it bundles is refused
  (USAGE_INVALID) even with --force: VAT never writes over what it reads.

Output:
  YAML report on stdout (schema: packages/cli/schemas/skills-package.json):
  status ok|findings|error, examined (1 skill), findings[] (every validation
  finding, plus SKILL_PACKAGE_TOO_LARGE for a claude-web ZIP over 8 MB or
  SKILL_PACKAGING_FAILED when packaging refused the skill's content), and
  data: skill, version, outputPath (relative to the working directory; null
  when no package was produced), dryRun. Progress goes to stderr.

Exit Codes:
  0 - Packaged (or previewed with --dry-run); warnings and info do not block
  1 - An error-severity finding: the skill failed validation (nothing is
      packaged), packaging refused the skill's content (SKILL_PACKAGING_FAILED),
      or its claude-web ZIP exceeds 8 MB (SKILL_PACKAGE_TOO_LARGE)
  2 - The run could not start or finish; error.code says why: USAGE_INVALID
      (a <skill-path> naming nothing, an invalid --target, an unknown or
      empty --formats value, no project root,
      an --output already holding something and no --force, an --output
      holding the skill's own source, or one under a directory the OS will
      not let VAT examine, so it cannot tell), INPUT_UNREADABLE
      (a <skill-path> the OS will not stat or read, or a directory in the
      project the OS will not list -- the crawl names it, dry run or real;
      this verb takes no git snapshot), RUN_INCOMPLETE (an output the OS will not let the build
      write: a full disk, a read-only or unwritable output directory, a file
      in the way, a ZIP, npm package.json or marketplace manifest that could
      not be written -- its partial file removed), or INTERNAL_ERROR (an
      unexpected failure)

Requirements:
  projectRoot: required (errors if no vibe-agent-toolkit.config.yaml or .git/ ancestor)
  config:      required file with skills.* fields populated

  See docs/concepts/roots-and-config.md for terminology.

Examples:
  $ vat skills package SKILL.md -o dist/my-skill
  $ vat skills package SKILL.md -o dist/my-skill --force   # replace the previous package
  $ vat skills package SKILL.md -o /tmp/skill --dry-run
  $ vat skills package SKILL.md -o dist/my-skill -f zip,npm
`
    );

  return command;
}

/** `vat skills package` has no `--strict`: warnings never fail it. */
const PACKAGE_GATE: Gate = { strict: false };

/**
 * Validate the skill and render every finding to stderr.
 *
 * `locationRoot` is passed, not left to the validator's default, so every
 * finding and the ZIP-ceiling finding {@link buildSkillsPackageReport} adds
 * are located against the SAME root.
 */
async function validateForPackage(
  skillPath: string,
  basePath: string,
  locationRoot: string,
  logger: ReturnType<typeof createLogger>
): Promise<ValidationResult> {
  logger.info(`\n🔍 Validating skill...`);
  // `{}`: this verb reads no project config (nor does `packageSkill` below).
  const validationResult = await validateSkill({
    skillPath,
    rootDir: basePath,
    locationRoot,
    validation: {},
  });

  for (const line of formatSkillValidationLines(validationResult)) {
    logger.info(line);
  }
  return validationResult;
}

/**
 * The claude.ai ZIP ceiling, as a finding about the skill. Always `error` and
 * not overridable (`NonOverridableCode`): this verb reads no project config,
 * so a `validation.severity` key for it would parse and do nothing.
 */
function packageTooLargeIssue(message: string, location: string): ValidationIssue {
  return {
    severity: 'error',
    code: 'SKILL_PACKAGE_TOO_LARGE',
    message,
    location,
    fix: 'Link fewer or smaller resources from the skill, or package with --target claude-code, which has no upload ceiling.',
  };
}

/** What one `skills package` run produced, for {@link buildSkillsPackageReport}. */
interface SkillsPackageReportInput {
  /** The validation the gate ran — its findings are the report's. */
  validation: ValidationResult;
  data: SkillsPackageData;
  /**
   * The packager refused the skill: a claude-web ZIP over 8 MB
   * (`SKILL_PACKAGE_TOO_LARGE`) or the skill's own content
   * (`SKILL_PACKAGING_FAILED`) — its message, and the skill's `SKILL.md` location.
   */
  refused?: { code: 'SKILL_PACKAGE_TOO_LARGE' | 'SKILL_PACKAGING_FAILED'; message: string; location: string } | undefined;
}

/** The finding a packaging refusal publishes. */
function refusedIssue(refused: NonNullable<SkillsPackageReportInput['refused']>): ValidationIssue {
  return refused.code === 'SKILL_PACKAGE_TOO_LARGE'
    ? packageTooLargeIssue(refused.message, refused.location)
    : packagingFailedIssue(refused.message, refused.location, 're-run vat skills package');
}

/**
 * THE document of one run. `examined` is the one skill; every validation
 * finding is published whatever its severity, so the status is the literal
 * `ok`/`findings` and the exit code derives from the counts — warnings never
 * block (no `--strict`), an error does.
 */
export function buildSkillsPackageReport(input: SkillsPackageReportInput): Report<SkillsPackageData> {
  const issues = [
    ...input.validation.issues,
    ...(input.refused === undefined ? [] : [refusedIssue(input.refused)]),
  ];
  return buildReport({ examined: 1, findings: toFindings(issues), data: input.data, gate: PACKAGE_GATE });
}

/**
 * Render the validation report: a headline that names what was found, then every
 * issue labelled with its own severity.
 *
 * Two silent drops used to live here. The renderer filtered to `error` and
 * `warning` only, so every `info` finding vanished; and the caller only invoked
 * it for an error result, so a warning-severity result printed a bare
 * `✅ Validation passed` — exactly the case that got swallowed.
 */
export function formatSkillValidationLines(validationResult: ValidationResult): string[] {
  const { issues, summary } = validationResult;
  if (issues.length === 0) {
    return ['✅ Validation passed — no findings'];
  }

  let headline: string;
  if (summary.errors > 0) {
    headline = `\n❌ Skill validation failed — ${formatIssueSetHeading(issues)}`;
  } else {
    const glyph = summary.warnings > 0 ? '⚠️ ' : 'ℹ️ ';
    headline = `\n${glyph} Validation passed with findings — ${formatIssueSetHeading(issues)}`;
  }

  const lines = [headline, `   Summary: ${validationResult.description}\n`];
  for (const issue of issues) {
    lines.push(...formatIssueLines(issue, '  '));
  }
  lines.push('');
  return lines;
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
  totalSize += statSync(skillPath).size;

  for (const file of linkedFiles) {
    if (existsSync(file)) {
      totalSize += statSync(file).size;
    }
  }

  // Rough estimate: 60% compression for markdown
  return Math.round((totalSize * 0.6) / 1024);
}

/** A path as the report publishes it: relative to the working directory, forward slashes. */
function reportPath(path: string): string {
  return toForwardSlash(safePath.relative(process.cwd(), safePath.resolve(path)));
}

/** The frontmatter `version` as the report publishes it: a string, or `null` when none is declared. */
function frontmatterVersion(parseResult: ParseResult): string | null {
  const version = parseResult.frontmatter?.['version'];
  return typeof version === 'string' || typeof version === 'number' ? String(version) : null;
}

/**
 * The `--formats` value, or the invocation's mistake. An unknown name used to
 * be dropped by the packager, so `--formats zpi` wrote only the directory and
 * exited 0.
 */
function resolvePackageFormats(rawFormats: string | undefined): PackageFormat[] {
  if (rawFormats === undefined) return [...DEFAULT_FORMATS];
  const requested = rawFormats.split(',').map((format) => format.trim()).filter((format) => format !== '');
  const unknown = requested.filter((format) => !(VALID_FORMATS as readonly string[]).includes(format));
  if (requested.length === 0 || unknown.length > 0) {
    const quoted = unknown.map((format) => JSON.stringify(format)).join(', ');
    const named = unknown.length > 0 ? `Unknown --formats value(s): ${quoted}` : '--formats names no format';
    throw new CommandRefusalError('USAGE_INVALID', `${named}. Valid formats are: ${VALID_FORMATS.join(', ')}`);
  }
  return requested as PackageFormat[];
}

/** Test seam: the report's pure field derivations, and the `--formats` resolver. */
export const __internal = { extractSkillName, frontmatterVersion, reportPath, resolvePackageFormats };

/**
 * Preview the package: the packager's own dry run (`dryRun: true`), so the
 * project crawl, the link walk and the output check that can refuse the real run
 * refuse the preview the same way — and the file list is the one the real run
 * would copy. Runs after the validation gate passed.
 */
async function previewPackage(
  skillPath: string,
  options: SkillsPackageCommandOptions,
  packageOptions: PackageSkillOptions,
  logger: ReturnType<typeof createLogger>
): Promise<SkillsPackageData> {
  logger.info(`🔍 Dry-run: Analyzing skill packaging...`);
  logger.info(`   Source: ${skillPath}`);
  logger.info(`   Output: ${options.output}`);

  const plan = await packageSkill(skillPath, { ...packageOptions, dryRun: true });
  logger.info(`   Skill: ${plan.skill.name}`);

  logger.info(`\n📁 Files to be packaged:`);
  logger.info(`   - SKILL.md (root)`);
  for (const file of plan.files.dependencies) {
    logger.info(`   - ${toForwardSlash(file)}`);
  }
  logger.info(`\n   Total: ${plan.files.dependencies.length + 1} files`);

  const formats = packageOptions.formats ?? [];
  logger.info(`\n📦 Formats to create:`);
  for (const format of formats) {
    logger.info(`   - ${format}`);
  }

  if (formats.includes('zip')) {
    const estimatedZipSize = calculateZipSize(skillPath, (plan.plannedSources ?? []).filter((file) => file !== skillPath));
    logger.info(`\n📊 Estimated ZIP size: ~${estimatedZipSize}KB`);
  }

  logger.info(`\n✅ Dry-run complete (no files created)`);
  logger.info(`   Run without --dry-run to create the package`);
  return { skill: plan.skill.name, version: plan.skill.version ?? null, outputPath: reportPath(options.output), dryRun: true };
}

/**
 * Which finding a `packageSkill` throw is, or `undefined` for a defect. Only
 * the packager's CODED refusals are findings about the skill — the claude.ai
 * ZIP ceiling, and its refusal of the skill's own content; an uncoded throw is
 * VAT's, and reaches the command's `INTERNAL_ERROR`.
 */
export function packagingRefusalCode(error: unknown): 'SKILL_PACKAGE_TOO_LARGE' | 'SKILL_PACKAGING_FAILED' | undefined {
  if (error instanceof ZipSizeLimitError) return 'SKILL_PACKAGE_TOO_LARGE';
  return isSkillPackagingInputError(error) ? 'SKILL_PACKAGING_FAILED' : undefined;
}

/** The `--target` value, or the invocation's mistake. */
function resolveTarget(rawTarget: string): PackagingTarget {
  if (!VALID_TARGETS.includes(rawTarget as PackagingTarget)) {
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `Invalid --target value: "${rawTarget}". Valid targets are: ${VALID_TARGETS.join(', ')}`,
    );
  }
  return rawTarget as PackagingTarget;
}

/**
 * Package the skill — or, with `--dry-run`, preview it through the same packager
 * call. A claude-web ZIP over the 8 MB claude.ai ceiling, and the packager
 * refusing the skill's own content, are FINDINGS about the skill, not failures of
 * the run; every other throw reaches the command's refusal.
 */
async function packageAndReport(
  skillPath: string,
  options: SkillsPackageCommandOptions,
  target: PackagingTarget,
  formats: readonly PackageFormat[],
  validation: ValidationResult,
  locationRoot: string,
  logger: ReturnType<typeof createLogger>
): Promise<Report<SkillsPackageData>> {
  const packageOptions: PackageSkillOptions = {
    formats: [...formats],
    rewriteLinks: resolveRewriteLinks(options),
    outputPath: options.output,
    target,
    ...(options.force === true && { replaceExistingOutput: true }),
  };
  // Only set when explicitly supplied — packageSkill() owns the fallback for
  // this field, so an unconditional resolveBasePath() here would change it.
  if (options.basePath) {
    packageOptions.basePath = options.basePath;
  }

  try {
    if (options.dryRun === true) {
      return buildSkillsPackageReport({ validation, data: await previewPackage(skillPath, options, packageOptions, logger) });
    }
    const result = await packageSkill(skillPath, packageOptions);
    logger.info(`✅ Packaged skill: ${result.skill.name}`);
    logger.info(`   Output: ${result.outputPath}`);
    if (result.artifacts?.['zip']) {
      logger.info(`   ZIP: ${basename(result.artifacts['zip'])}`);
    }
    return buildSkillsPackageReport({
      validation,
      data: { skill: result.skill.name, version: result.skill.version ?? null, outputPath: reportPath(result.outputPath), dryRun: false },
    });
  } catch (error) {
    const code = packagingRefusalCode(error);
    if (code === undefined) throw error;
    const tooLarge = code === 'SKILL_PACKAGE_TOO_LARGE';
    const message = errorMessageOf(error);
    logger.error(`Package failed: ${message}`);
    const parseResult = await parseFileCached(skillPath, 'markdown');
    return buildSkillsPackageReport({
      validation,
      // A too-large ZIP is on disk beside its directory; a refused skill left no bundle.
      data: { skill: extractSkillName(parseResult), version: frontmatterVersion(parseResult), outputPath: tooLarge ? reportPath(options.output) : null, dryRun: options.dryRun === true },
      refused: { code, message, location: issueLocation(skillPath, locationRoot) },
    });
  }
}

/**
 * The SKILL.md the argument names, or the invocation's refusal — the same
 * policy `vat skill review` applies to its path: a path naming nothing is
 * `USAGE_INVALID`, one the OS will not stat or read is `INPUT_UNREADABLE`.
 * Decided here, before the validator, whose own existence probe cannot tell
 * the two apart and whose read is uncoded.
 */
function resolvePackageSource(skillPath: string): string {
  const skillFile = resolveSkillPath(skillPath);
  readInputFile(skillFile, { code: 'USAGE_INVALID', message: `Path does not exist: ${skillFile}` });
  return skillFile;
}

/** One run, as the report it publishes: the gate's failure, a dry run's preview, or the package. */
async function runPackage(
  skillPathArg: string,
  options: SkillsPackageCommandOptions,
  logger: ReturnType<typeof createLogger>
): Promise<Report<SkillsPackageData>> {
  const skillPath = resolvePackageSource(skillPathArg);
  // Spec §7: `vat skills package` requires a projectRoot — fails fast at
  // the CLI boundary if no config or git ancestor exists.
  requireProjectRoot(process.cwd(), 'vat skills package');

  logger.info(`📦 Packaging skill: ${skillPathArg}`);
  const target = resolveTarget(options.target ?? DEFAULT_TARGET);
  const formats = resolvePackageFormats(options.formats);

  // VALIDATE FIRST - shift left to catch errors early.
  const skillDir = dirname(skillPath);
  const locationRoot = findProjectRoot(skillDir) ?? skillDir;
  const validation = await validateForPackage(skillPath, resolveBasePath(options, skillPath), locationRoot, logger);
  logger.info('');

  if (validation.summary.errors > 0) {
    // The gate stopped it: nothing was packaged, and the document says so.
    const skill = validation.metadata?.name ?? basename(skillDir);
    return buildSkillsPackageReport({ validation, data: { skill, version: null, outputPath: null, dryRun: options.dryRun === true } });
  }
  return packageAndReport(skillPath, options, target, formats, validation, locationRoot, logger);
}

async function packageCommand(
  skillPath: string,
  options: SkillsPackageCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  let report: Report<SkillsPackageData>;
  try {
    report = await runPackage(skillPath, options, logger);
  } catch (error) {
    endWithRefusal('skills package', refusalCodeOf(error), error, 'yaml', PACKAGE_GATE, NOTHING_FINISHED);
  }
  endWithReport('skills package', report, 'yaml');
}

/**
 * Audit command - audits plugins, marketplaces, registries, and Agent Skills
 * Top-level command: vat audit [path]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  detectResourceFormat,
  validate,
  validateSkill,
  type ValidateOptions,
  type ValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import { detectFormat } from '@vibe-agent-toolkit/discovery';
import { Command } from 'commander';

import { getClaudeUserPaths } from '../utils/claude-paths.js';
import { handleCommandError } from '../utils/command-error.js';
import { createLogger } from '../utils/logger.js';
import { writeYamlOutput } from '../utils/output.js';

import { buildHierarchicalOutput } from './audit/hierarchical-output.js';

export interface AuditCommandOptions {
  debug?: boolean;
  recursive?: boolean;
  user?: boolean;
  verbose?: boolean; // Commander sets this for --verbose
  warnUnreferencedFiles?: boolean; // Commander sets this for --warn-unreferenced-files
}

/**
 * Create audit command
 * Top-level command: vat audit [path]
 */
export function createAuditCommand(): Command {
  const audit = new Command('audit');

  audit
    .description('Audit Claude plugins, marketplaces, registries, and skills')
    .argument('[path]', 'Path to audit (default: current directory)')
    .option('-r, --recursive', 'Scan directories recursively for all resource types')
    .option('--user', 'Audit user-level Claude resources (~/.claude/plugins, ~/.claude/skills, ~/.claude/marketplaces)')
    .option('--verbose', 'Show all scanned resources, including those without issues')
    .option('--warn-unreferenced-files', 'Warn about files not referenced in skill markdown')
    .option('--debug', 'Enable debug logging')
    .action(auditCommand)
    .addHelpText(
      'after',
      `
Description:
  Audits Claude plugins, marketplaces, registries, and Agent Skills for
  quality, correctness, and compatibility. Automatically detects resource
  type and validates accordingly. Outputs YAML report to stdout,
  errors/warnings to stderr.

  Supported resource types:
  - Plugin directories (.claude-plugin/plugin.json)
  - Marketplace directories (.claude-plugin/marketplace.json)
  - Registry files (installed_plugins.json, known_marketplaces.json)
  - Agent Skills (SKILL.md files)
  - VAT agents (agent.yaml + SKILL.md)

  Path can be: resource directory, registry file, SKILL.md file, or scan directory
  Default: current directory
  Use --user to audit user-level installation automatically

  --user scans:
  - ~/.claude/plugins (installed plugins)
  - ~/.claude/skills (standalone skills)
  - ~/.claude/marketplaces (marketplace plugins)

  --user skips:
  - ~/.claude/projects (project-specific files)
  - ~/.claude/logs (log files)
  - ~/.claude/cache (cached data)

Validation Behavior:
  Default: Validates SKILL.md and all transitively linked markdown files
  --warn-unreferenced-files: Also detect files not referenced in skill

Validation Checks:
  Errors (must fix):
  - Missing or invalid manifests/frontmatter
  - Schema validation failures
  - Broken links to other files (Skills only)
  - Reserved words in names (Skills only)
  - XML tags in frontmatter fields (Skills only)
  - Windows-style backslashes in paths (Skills only)

  Warnings (should fix):
  - Skill exceeds recommended length (>5000 lines)
  - References console-incompatible tools (Skills only)
  - Unreferenced files detected (with --warn-unreferenced-files)

Exit Codes:
  0 - Success (--user mode: always exits 0 for informational output)
  1 - Errors found (non-user mode only)
  2 - System error (directory not found, file not readable)

Examples:
  $ vat audit --user                   # Audit user-level installation (informational)
  $ vat audit                          # Audit current directory
  $ vat audit ./my-plugin              # Audit plugin directory
  $ vat audit installed_plugins.json   # Audit registry file
  $ vat audit ./resources --recursive  # Audit all resources recursively
`
    );

  return audit;
}


export async function auditCommand(
  targetPath: string | undefined,
  options: AuditCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    let scanPath: string;
    let recursive: boolean = options.recursive ?? false;

    // Handle --user flag
    if (options.user) {
      const { pluginsDir, skillsDir, marketplacesDir } = getClaudeUserPaths();

      // Check if any target directories exist
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: path constructed from os.homedir()
      const pluginsDirExists = fs.existsSync(pluginsDir);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: path constructed from os.homedir()
      const skillsDirExists = fs.existsSync(skillsDir);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: path constructed from os.homedir()
      const marketplacesDirExists = fs.existsSync(marketplacesDir);

      if (!pluginsDirExists && !skillsDirExists && !marketplacesDirExists) {
        logger.error(`No user-level Claude directories found:`);
        logger.error(`  Plugins: ${pluginsDir}`);
        logger.error(`  Skills: ${skillsDir}`);
        logger.error(`  Marketplaces: ${marketplacesDir}`);
        logger.error('Claude plugins/skills/marketplaces have not been installed yet.');
        process.exit(2);
      }

      // Scan all directories that exist
      const results: ValidationResult[] = [];
      recursive = true; // Always recursive for user-level audit

      if (pluginsDirExists) {
        logger.debug(`Auditing user-level plugins at: ${pluginsDir}`);
        const pluginResults = await getValidationResults(pluginsDir, recursive, options, logger);
        results.push(...pluginResults);
      }

      if (skillsDirExists) {
        logger.debug(`Auditing user-level skills at: ${skillsDir}`);
        const skillResults = await getValidationResults(skillsDir, recursive, options, logger);
        results.push(...skillResults);
      }

      if (marketplacesDirExists) {
        logger.debug(`Auditing user-level marketplaces at: ${marketplacesDir}`);
        const marketplaceResults = await getValidationResults(marketplacesDir, recursive, options, logger);
        results.push(...marketplaceResults);
      }

      // Use hierarchical output for --user flag
      const skillResults = results.filter((r: ValidationResult) => r.type === 'agent-skill');
      const hierarchical = buildHierarchicalOutput(skillResults, options.verbose ?? false);
      const summary = calculateHierarchicalSummary(results, hierarchical, startTime);
      writeYamlOutput(summary);
      logHierarchicalSummary(results, hierarchical, logger);
      return;
    } else {
      scanPath = targetPath ? path.resolve(targetPath) : process.cwd();
      logger.debug(`Auditing resources at: ${scanPath}`);
    }

    // Get validation results (non-user path)
    const results = await getValidationResults(scanPath, recursive, options, logger);

    // Standard flat output
    const summary = calculateSummary(results, startTime);
    writeYamlOutput(summary);
    handleAuditResults(results, summary, logger);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'AgentAudit');
  }
}

async function getValidationResults(
  scanPath: string,
  recursive: boolean,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>
): Promise<ValidationResult[]> {
  const format = detectFormat(scanPath);

  // Special handling for direct SKILL.md file
  if (format === 'agent-skill') {
    logger.debug('Detected single Agent Skill');
    const validateOptions: ValidateOptions = { skillPath: scanPath };
    if (options.warnUnreferencedFiles) {
      validateOptions.checkUnreferencedFiles = true;
    }
    const result = await validateSkill(validateOptions);
    return [result];
  }

  // Special handling for VAT agent: validate its SKILL.md
  if (format === 'vat-agent') {
    const skillPath = path.join(scanPath, 'SKILL.md');
    logger.debug('Detected VAT agent, validating SKILL.md');
    const validateOptions: ValidateOptions = { skillPath, isVATGenerated: true };
    if (options.warnUnreferencedFiles) {
      validateOptions.checkUnreferencedFiles = true;
    }
    const result = await validateSkill(validateOptions);
    return [result];
  }

  // For plugin/marketplace directories or registry files, use unified validator
  const resourceFormat = await detectResourceFormat(scanPath);

  if (resourceFormat.type !== 'unknown') {
    logger.debug(`Detected ${resourceFormat.type} at: ${scanPath}`);
    const result = await validate(scanPath);
    return [result];
  }

  // If unknown format, check if it's a directory we can scan
  const fs = await import('node:fs/promises');
  try {
    const stat = await fs.stat(scanPath);
    if (stat.isDirectory()) {
      logger.debug('Scanning directory for resources');
      return scanDirectory(scanPath, recursive, options, logger);
    }
  } catch {
    // Path doesn't exist or not accessible, let validate() handle it
  }

  // Unknown resource type - use unified validator which will return appropriate error
  logger.debug(`Unknown resource type at: ${scanPath}`);
  const result = await validate(scanPath);
  return [result];
}

function calculateSummary(results: ValidationResult[], startTime: number) {
  const base = buildBaseSummary(results, startTime);
  return {
    ...base,
    files: results,
  };
}

function handleAuditResults(
  results: ValidationResult[],
  summary: { summary: { errors: number; warnings: number; success: number } },
  logger: ReturnType<typeof createLogger>
): void {
  const { errors: errorCount, warnings: warningCount, success: successCount } = summary.summary;

  if (errorCount > 0) {
    logErrors(results, errorCount, logger);
    process.exit(1);
  }

  if (warningCount > 0) {
    logWarnings(results, warningCount, logger);
  } else {
    logger.info(`Audit successful: ${successCount} file(s) passed`);
  }

  process.exit(0);
}

function logErrors(
  results: ValidationResult[],
  errorCount: number,
  logger: ReturnType<typeof createLogger>
): void {
  logger.error(`Audit failed: ${errorCount} file(s) with errors`);
  const errorResults = results.filter((r: ValidationResult) => r.status === 'error');

  for (const result of errorResults) {
    logger.error(`\n${result.path}:`);
    const errorIssues = result.issues.filter((i: { severity: string }) => i.severity === 'error');
    logIssues(errorIssues, logger.error.bind(logger));
  }
}

function logWarnings(
  results: ValidationResult[],
  warningCount: number,
  logger: ReturnType<typeof createLogger>
): void {
  logger.info(`Audit passed with warnings: ${warningCount} file(s)`);
  const warningResults = results.filter((r: ValidationResult) => r.status === 'warning');

  for (const result of warningResults) {
    logger.info(`\n${result.path}:`);
    const warningIssues = result.issues.filter((i: { severity: string }) => i.severity === 'warning');
    logIssues(warningIssues, logger.info.bind(logger));
  }
}

function logIssues(
  issues: Array<{ code: string; message: string; location?: string; fix?: string }>,
  logFn: (message: string) => void
): void {
  for (const issue of issues) {
    logFn(`  [${issue.code}] ${issue.message}`);
    if (issue.location) {
      logFn(`    at: ${issue.location}`);
    }
    if (issue.fix) {
      logFn(`    fix: ${issue.fix}`);
    }
  }
}

/**
 * Handle file entry during directory scan
 */
async function handleFileEntry(
  entry: { name: string },
  fullPath: string,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>
): Promise<ValidationResult | null> {
  // Check for registry files
  if (entry.name === 'installed_plugins.json' || entry.name === 'known_marketplaces.json') {
    logger.debug(`Validating registry: ${fullPath}`);
    return validate(fullPath);
  }

  // Check for SKILL.md
  if (entry.name === 'SKILL.md') {
    logger.debug(`Validating Agent Skill: ${fullPath}`);
    const validateOptions: ValidateOptions = { skillPath: fullPath };
    if (options.warnUnreferencedFiles) {
      validateOptions.checkUnreferencedFiles = true;
    }
    return validateSkill(validateOptions);
  }

  return null;
}

/**
 * Handle directory entry during directory scan
 */
async function handleDirectoryEntry(
  fullPath: string,
  recursive: boolean,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>
): Promise<ValidationResult[]> {
  const fs = await import('node:fs/promises');
  const results: ValidationResult[] = [];

  // Check if directory contains a plugin or marketplace
  const claudePluginDir = path.join(fullPath, '.claude-plugin');
  const hasClaudePlugin = await fs.access(claudePluginDir).then(() => true).catch(() => false);

  if (hasClaudePlugin) {
    logger.debug(`Validating resource directory: ${fullPath}`);
    const result = await validate(fullPath);
    results.push(result);
  }

  // Recurse into subdirectories (both plugin/marketplace dirs and regular dirs)
  if (recursive) {
    const subResults = await scanDirectory(fullPath, recursive, options, logger);
    results.push(...subResults);
  }

  return results;
}

async function scanDirectory(
  dirPath: string,
  recursive: boolean,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>
): Promise<ValidationResult[]> {
  const fs = await import('node:fs/promises');
  const results: ValidationResult[] = [];

  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isFile()) {
      const result = await handleFileEntry(entry, fullPath, options, logger);
      if (result !== null) {
        results.push(result);
      }
    } else if (entry.isDirectory()) {
      const dirResults = await handleDirectoryEntry(fullPath, recursive, options, logger);
      results.push(...dirResults);
    }
  }

  return results;
}

/**
 * Calculate overall status from validation results
 */
function calculateOverallStatus(results: ValidationResult[]): 'success' | 'warning' | 'error' {
  const errorCount = results.filter((r: ValidationResult) => r.status === 'error').length;
  const warningCount = results.filter((r: ValidationResult) => r.status === 'warning').length;

  if (errorCount > 0) {
    return 'error';
  }
  if (warningCount > 0) {
    return 'warning';
  }
  return 'success';
}

/**
 * Count all skills in hierarchical output
 */
function countAllSkills(hierarchical: ReturnType<typeof buildHierarchicalOutput>): number {
  let total = 0;

  // Count marketplace skills
  for (const marketplace of hierarchical.marketplaces) {
    for (const plugin of marketplace.plugins) {
      total += plugin.skills.length;
    }
  }

  // Count cached plugin skills
  for (const plugin of hierarchical.cachedPlugins) {
    total += plugin.skills.length;
  }

  // Count standalone plugin skills
  for (const plugin of hierarchical.standalonePlugins) {
    total += plugin.skills.length;
  }

  // Count standalone skills
  total += hierarchical.standaloneSkills.length;

  return total;
}

/**
 * Calculate issue counts from validation results
 */
function calculateIssueCounts(results: ValidationResult[]) {
  const successCount = results.filter((r: ValidationResult) => r.status === 'success').length;
  const warningCount = results.filter((r: ValidationResult) => r.status === 'warning').length;
  const errorCount = results.filter((r: ValidationResult) => r.status === 'error').length;

  const totalErrors = results.reduce((sum: number, r: ValidationResult) =>
    sum + r.issues.filter(i => i.severity === 'error').length, 0
  );
  const totalWarnings = results.reduce((sum: number, r: ValidationResult) =>
    sum + r.issues.filter(i => i.severity === 'warning').length, 0
  );
  const totalInfo = results.reduce((sum: number, r: ValidationResult) =>
    sum + r.issues.filter(i => i.severity === 'info').length, 0
  );

  return {
    successCount,
    warningCount,
    errorCount,
    totalErrors,
    totalWarnings,
    totalInfo,
  };
}

/**
 * Build base summary structure (used by both flat and hierarchical)
 */
function buildBaseSummary(
  results: ValidationResult[],
  startTime: number
): {
  status: string;
  summary: { filesScanned: number; success: number; warnings: number; errors: number };
  issues: { errors: number; warnings: number; info: number };
  duration: string;
} {
  const counts = calculateIssueCounts(results);
  const status = calculateOverallStatus(results);

  return {
    status,
    summary: {
      filesScanned: results.length,
      success: counts.successCount,
      warnings: counts.warningCount,
      errors: counts.errorCount,
    },
    issues: {
      errors: counts.totalErrors,
      warnings: counts.totalWarnings,
      info: counts.totalInfo,
    },
    duration: `${Date.now() - startTime}ms`,
  };
}

/**
 * Calculate summary for hierarchical output
 */
function calculateHierarchicalSummary(
  results: ValidationResult[],
  hierarchical: ReturnType<typeof buildHierarchicalOutput>,
  startTime: number
) {
  const base = buildBaseSummary(results, startTime);

  return {
    ...base,
    summary: {
      ...base.summary,
      marketplaces: hierarchical.marketplaces.length,
      cachedPlugins: hierarchical.cachedPlugins.length,
      standalonePlugins: hierarchical.standalonePlugins.length,
      standaloneSkills: hierarchical.standaloneSkills.length,
    },
    hierarchical,
  };
}

/**
 * Log hierarchical summary to stderr
 */
function logHierarchicalSummary(
  results: ValidationResult[],
  hierarchical: ReturnType<typeof buildHierarchicalOutput>,
  logger: ReturnType<typeof createLogger>
): void {
  const status = calculateOverallStatus(results);
  const skillsWithIssues = countAllSkills(hierarchical);
  const totalSkills = results.length;

  if (status === 'error') {
    const errorCount = results.filter((r: ValidationResult) => r.status === 'error').length;
    logger.error(`Audit failed: ${errorCount} skill(s) with errors (${totalSkills} scanned, ${skillsWithIssues} with issues)`);
    process.exit(1);
  }

  if (status === 'warning') {
    const warningCount = results.filter((r: ValidationResult) => r.status === 'warning').length;
    logger.info(`Audit passed with warnings: ${warningCount} skill(s) (${totalSkills} scanned, ${skillsWithIssues} with issues)`);
  } else {
    logger.info(`Audit successful: ${totalSkills} skill(s) passed`);
  }

  process.exit(0);
}

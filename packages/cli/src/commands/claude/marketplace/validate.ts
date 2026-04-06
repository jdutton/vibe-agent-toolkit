/* eslint-disable security/detect-non-literal-fs-filename -- Paths are user-provided CLI arguments */
/**
 * `vat claude marketplace validate [path]` — strict marketplace validation.
 *
 * Validates a marketplace directory with strict requirements:
 * - .claude-plugin/marketplace.json must exist and be valid
 * - Each plugin must have valid plugin.json with version (error, not warning)
 * - LICENSE file must exist (error)
 * - README.md should exist (warning)
 * - CHANGELOG.md should exist (warning)
 */

import { existsSync, readdirSync } from 'node:fs';


import {
  validateMarketplace,
  validatePlugin,
  validateSkill,
} from '@vibe-agent-toolkit/agent-skills';
import type {
  ValidationIssue,
  ValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { formatDuration, handleCommandError } from '../../../utils/command-error.js';
import { createLogger } from '../../../utils/logger.js';
import { writeYamlOutput } from '../../../utils/output.js';

interface MarketplaceValidateOptions {
  debug?: boolean;
}

/**
 * Check for required/recommended files in the marketplace root.
 */
function checkMarketplaceFiles(marketplacePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const fileChecks: Array<{ file: string; code: string; severity: 'error' | 'warning'; verb: string }> = [
    { file: 'LICENSE', code: 'MARKETPLACE_MISSING_LICENSE', severity: 'error', verb: 'required for distribution' },
    { file: 'README.md', code: 'MARKETPLACE_MISSING_README', severity: 'warning', verb: 'recommended for documentation' },
    { file: 'CHANGELOG.md', code: 'MARKETPLACE_MISSING_CHANGELOG', severity: 'warning', verb: 'recommended for tracking changes' },
  ];

  for (const check of fileChecks) {
    if (!existsSync(safePath.join(marketplacePath, check.file))) {
      issues.push({
        severity: check.severity,
        code: check.code as ValidationIssue['code'],
        message: `Marketplace is missing a ${check.file} — ${check.verb}`,
        location: safePath.join(marketplacePath, check.file),
        fix: `Add a ${check.file} to the marketplace root directory`,
      });
    }
  }

  return issues;
}

/**
 * Validate all SKILL.md files within a plugin's skills/ directory.
 */
async function validatePluginSkills(pluginDir: string): Promise<ValidationIssue[]> {
  const skillsDir = safePath.join(pluginDir, 'skills');
  if (!existsSync(skillsDir)) return [];

  const issues: ValidationIssue[] = [];
  const skillEntries = readdirSync(skillsDir, { withFileTypes: true });

  for (const skillEntry of skillEntries) {
    if (!skillEntry.isDirectory()) continue;

    const skillDir = safePath.join(skillsDir, skillEntry.name);
    const skillMdPath = safePath.join(skillDir, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    const skillResult = await validateSkill({ skillPath: skillMdPath, rootDir: skillDir });
    issues.push(...skillResult.issues);
  }

  return issues;
}

/**
 * Validate all plugins under the plugins/ directory.
 */
async function validatePlugins(
  marketplacePath: string,
): Promise<{ pluginResults: ValidationResult[]; issues: ValidationIssue[] }> {
  const pluginsDir = safePath.join(marketplacePath, 'plugins');
  if (!existsSync(pluginsDir)) return { pluginResults: [], issues: [] };

  const pluginResults: ValidationResult[] = [];
  const issues: ValidationIssue[] = [];
  const entries = readdirSync(pluginsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginDir = safePath.join(pluginsDir, entry.name);
    const pluginResult = await validatePlugin(pluginDir, { strict: true });
    pluginResults.push(pluginResult);
    issues.push(...pluginResult.issues);

    const skillIssues = await validatePluginSkills(pluginDir);
    issues.push(...skillIssues);
  }

  return { pluginResults, issues };
}

/**
 * Determine overall validation status from issues.
 */
function determineStatus(issues: ValidationIssue[]): 'success' | 'warning' | 'error' {
  if (issues.some(i => i.severity === 'error')) return 'error';
  if (issues.some(i => i.severity === 'warning')) return 'warning';
  return 'success';
}

async function marketplaceValidateCommand(
  targetPath: string | undefined,
  options: MarketplaceValidateOptions,
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const marketplacePath = safePath.resolve(targetPath ?? '.');
    logger.info(`Validating marketplace: ${marketplacePath}`);

    // 1. Validate marketplace.json
    const marketplaceResult = await validateMarketplace(marketplacePath);

    // If marketplace manifest is missing or invalid, bail early
    if (marketplaceResult.status === 'error') {
      const duration = formatDuration(Date.now() - startTime);
      writeYamlOutput({
        status: 'error',
        path: marketplacePath,
        summary: marketplaceResult.summary,
        issues: marketplaceResult.issues,
        duration,
      });
      process.exit(1);
    }

    // 2. Check required/recommended files
    const fileIssues = checkMarketplaceFiles(marketplacePath);

    // 3. Validate plugins and their skills
    const { pluginResults, issues: pluginIssues } = await validatePlugins(marketplacePath);

    // Combine all issues
    const allIssues = [...marketplaceResult.issues, ...fileIssues, ...pluginIssues];
    const status = determineStatus(allIssues);
    const errorCount = allIssues.filter(i => i.severity === 'error').length;
    const warningCount = allIssues.filter(i => i.severity === 'warning').length;
    const duration = formatDuration(Date.now() - startTime);

    writeYamlOutput({
      status,
      path: marketplacePath,
      marketplace: marketplaceResult.metadata,
      plugins: pluginResults.map(r => ({
        path: r.path,
        status: r.status,
        metadata: r.metadata,
        issues: r.issues,
      })),
      issues: allIssues,
      summary: `${errorCount} error(s), ${warningCount} warning(s)`,
      duration,
    });

    process.exit(status === 'error' ? 1 : 0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'MarketplaceValidate');
  }
}

export function createMarketplaceValidateCommand(): Command {
  const command = new Command('validate');

  command
    .description('Validate a marketplace directory for publishing')
    .argument('[path]', 'Path to marketplace directory (default: current directory)')
    .option('-d, --debug', 'Enable debug logging')
    .action(marketplaceValidateCommand)
    .addHelpText('after', `
Description:
  Validates a marketplace directory with strict requirements for publishing.
  Checks marketplace.json, plugin manifests, skills, LICENSE, README, and CHANGELOG.

  Plugin versions are required (error, not warning) in strict marketplace validation.

Exit Codes:
  0 - All validations passed (warnings allowed)
  1 - Validation errors found
  2 - System error (directory not found, etc.)

Example:
  $ vat claude marketplace validate .         # Validate current directory
`);

  return command;
}

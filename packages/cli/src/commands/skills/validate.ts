/**
 * Skills validate command - unified validation for SKILL.md files
 *
 * Combines resource validation (markdown, links, frontmatter) with
 * skill-specific validation (reserved words, XML tags, console compatibility).
 *
 * This replaces the two-step validation approach (resource + skill) with a
 * single unified command that reports all errors together.
 */

import * as path from 'node:path';

import { validateSkill, type ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import { ResourceRegistry, type ValidationResult as ResourceValidationResult } from '@vibe-agent-toolkit/resources';
import * as yaml from 'js-yaml';

import { formatDurationSecs } from '../../utils/duration.js';
import { createLogger } from '../../utils/logger.js';
import { findSkillFiles } from '../../utils/skill-finder.js';

import { handleCommandError } from './command-helpers.js';

/**
 * Unified skill validation result
 */
interface UnifiedSkillValidationResult {
  skill: string;
  path: string;
  status: 'success' | 'error';
  resourceValidation: {
    status: 'success' | 'error';
    linksChecked: number;
    errors: number;
  };
  skillValidation: {
    status: 'success' | 'error';
    errors: number;
    warnings: number;
  };
  totalErrors: number;
  totalWarnings: number;
  issues?: Array<{
    source: 'resource' | 'skill';
    severity: 'error' | 'warning' | 'info';
    code: string;
    message: string;
    location: string | undefined;
  }>;
}

/**
 * Unified output format
 */
interface UnifiedValidationOutput {
  status: 'success' | 'error';
  skillsValidated: number;
  results: UnifiedSkillValidationResult[];
  durationSecs: number;
}

/**
 * Validate a SKILL.md file using resource validation (links, frontmatter)
 */
async function validateSkillAsResource(
  skillPath: string,
  rootDir: string
): Promise<ResourceValidationResult> {
  const registry = new ResourceRegistry({ rootDir });

  // Add the entire resources directory to ensure all linked files are available for validation
  // This is necessary because SKILL.md links to agent markdown files in ../agents/
  const resourcesDir = path.resolve(path.dirname(skillPath), '..');
  await registry.crawl({ baseDir: resourcesDir, include: ['**/*.md'] });

  // Validate (no frontmatter schema by default)
  const result = await registry.validate();

  return result;
}

/**
 * Merge resource and skill validation results
 */
function mergeValidationResults(
  skillPath: string,
  resourceResult: ResourceValidationResult,
  skillResult: ValidationResult
): UnifiedSkillValidationResult {
  const skillName = skillResult.metadata?.name ?? path.basename(path.dirname(skillPath));

  // Extract resource errors (exclude external_url which are informational)
  const resourceErrors = resourceResult.issues.filter(i => i.type !== 'external_url');
  const resourceErrorCount = resourceErrors.length;

  // Extract skill errors and warnings
  const skillErrors = skillResult.issues.filter(i => i.severity === 'error');
  const skillWarnings = skillResult.issues.filter(i => i.severity === 'warning');
  const skillErrorCount = skillErrors.length;
  const skillWarningCount = skillWarnings.length;

  const totalErrors = resourceErrorCount + skillErrorCount;
  const totalWarnings = skillWarningCount;

  // Build unified issues array
  const issues: UnifiedSkillValidationResult['issues'] = [];

  // Add resource issues
  for (const issue of resourceErrors) {
    const location = issue.line === undefined ? skillPath : `${skillPath}:${issue.line}`;
    issues.push({
      source: 'resource',
      severity: 'error',
      code: issue.type,
      message: issue.message,
      location,
    });
  }

  // Add skill issues
  for (const issue of [...skillErrors, ...skillWarnings]) {
    issues.push({
      source: 'skill',
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      location: issue.location,
    });
  }

  return {
    skill: skillName,
    path: skillPath,
    status: totalErrors > 0 ? 'error' : 'success',
    resourceValidation: {
      status: resourceErrorCount > 0 ? 'error' : 'success',
      linksChecked: resourceResult.linksByType ? Object.values(resourceResult.linksByType).reduce((sum, count) => sum + count, 0) : 0,
      errors: resourceErrorCount,
    },
    skillValidation: {
      status: skillErrorCount > 0 ? 'error' : 'success',
      errors: skillErrorCount,
      warnings: skillWarningCount,
    },
    totalErrors,
    totalWarnings,
    ...(issues.length > 0 ? { issues } : {}),
  };
}

/**
 * Format skill status for console output
 */
function formatSkillStatus(result: UnifiedSkillValidationResult): string {
  if (result.status === 'error') {
    const errorText = `${result.totalErrors} error${result.totalErrors === 1 ? '' : 's'}`;
    const warningPlural = result.totalWarnings === 1 ? '' : 's';
    const warningText = result.totalWarnings > 0
      ? `, ${result.totalWarnings} warning${warningPlural}`
      : '';
    return `   ❌ ${result.skill} (${errorText}${warningText})`;
  }

  if (result.totalWarnings > 0) {
    const warningPlural = result.totalWarnings === 1 ? '' : 's';
    return `   ⚠️  ${result.skill} (${result.totalWarnings} warning${warningPlural})`;
  }

  return `   ✅ ${result.skill}`;
}

/**
 * Output detailed error for a single issue
 */
function outputDetailedIssue(issue: {
  source: 'resource' | 'skill';
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  location: string | undefined;
}): void {
  console.error(`      [${issue.source}] ${issue.severity}: ${issue.message} (${issue.code})`);
  if (issue.location !== undefined) {
    console.error(`      Location: ${issue.location}`);
  }
}

/**
 * Output unified validation report
 */
function outputUnifiedReport(results: UnifiedSkillValidationResult[], duration: number): void {
  const output: UnifiedValidationOutput = {
    status: results.some(r => r.status === 'error') ? 'error' : 'success',
    skillsValidated: results.length,
    results,
    durationSecs: formatDurationSecs(duration),
  };

  // Output YAML to stdout (for programmatic parsing)
  console.log(yaml.dump(output, { indent: 2, lineWidth: -1 }));

  // If there are errors, also write detailed errors to stderr
  const failedSkills = results.filter(r => r.status === 'error');
  if (failedSkills.length === 0) {
    return;
  }

  console.error('\n❌ Validation errors:\n');
  for (const result of failedSkills) {
    console.error(`   ${result.path}:`);
    if (result.issues) {
      for (const issue of result.issues) {
        outputDetailedIssue(issue);
      }
    }
    console.error('');
  }
}

/**
 * Skills validate command options
 */
interface SkillsValidateCommandOptions {
  debug?: boolean;
}

/**
 * Skills validate command implementation
 */
export async function validateCommand(
  pathArg: string | undefined,
  options: SkillsValidateCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const rootDir = pathArg ?? process.cwd();

    logger.info(`🔍 Validating skills in: ${rootDir}`);

    // Step 1: Find all SKILL.md files
    const skillPaths = findSkillFiles(path.join(rootDir, 'packages'));

    if (skillPaths.length === 0) {
      logger.info('   No SKILL.md files found');
      console.log(yaml.dump({
        status: 'success',
        skillsValidated: 0,
        results: [],
        durationSecs: formatDurationSecs(Date.now() - startTime),
      }, { indent: 2, lineWidth: -1 }));
      process.exit(0);
    }

    logger.info(`   Found ${skillPaths.length} skill${skillPaths.length === 1 ? '' : 's'}\n`);

    const results: UnifiedSkillValidationResult[] = [];

    // Step 2: Validate each skill with both validators
    for (const skillPath of skillPaths) {
      // 2a: Resource validation (markdown, links)
      const resourceResult = await validateSkillAsResource(skillPath, rootDir);

      // 2b: Skill-specific validation (reserved words, etc.)
      const skillResult = await validateSkill({ skillPath, rootDir });

      // 2c: Merge results
      const unified = mergeValidationResults(skillPath, resourceResult, skillResult);
      results.push(unified);

      // Show progress
      logger.info(formatSkillStatus(unified));
    }

    // Step 3: Output unified report
    const duration = Date.now() - startTime;
    logger.info('');
    outputUnifiedReport(results, duration);

    // Step 4: Exit with appropriate code
    const hasErrors = results.some(r => r.totalErrors > 0);
    process.exit(hasErrors ? 1 : 0);

  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsValidate');
  }
}

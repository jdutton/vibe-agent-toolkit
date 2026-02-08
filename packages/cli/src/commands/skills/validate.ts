/**
 * Skills validate command - unified validation for SKILL.md files
 *
 * Combines resource validation (markdown, links, frontmatter) with
 * skill-specific validation (reserved words, XML tags, console compatibility).
 *
 * Supports three modes:
 * 1. Project context (default): Validate project skills with strict filename validation
 * 2. User context (--user flag): Validate ~/.claude skills with permissive validation
 * 3. Path context (explicit path): Validate skills at specific path
 */

import * as path from 'node:path';

import { validateSkill, type ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import { scan } from '@vibe-agent-toolkit/discovery';
import { ResourceRegistry, type ValidationResult as ResourceValidationResult } from '@vibe-agent-toolkit/resources';
import { GitTracker } from '@vibe-agent-toolkit/utils';
import * as yaml from 'js-yaml';

import { loadConfig } from '../../utils/config-loader.js';
import { formatDurationSecs } from '../../utils/duration.js';
import { createLogger } from '../../utils/logger.js';
import { discoverSkills, validateSkillFilename } from '../../utils/skill-discovery.js';
import { scanUserContext } from '../../utils/user-context-scanner.js';

import { handleCommandError } from './command-helpers.js';

/**
 * Validation issue source type
 */
type IssueSource = 'resource' | 'skill' | 'filename';

/**
 * Validation issue severity
 */
type IssueSeverity = 'error' | 'warning' | 'info';

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
    source: IssueSource;
    severity: IssueSeverity;
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
  rootDir: string,
  gitTracker?: GitTracker
): Promise<ResourceValidationResult> {
  const registry = new ResourceRegistry({
    rootDir,
    ...(gitTracker !== undefined && { gitTracker })
  });

  // Add the entire resources directory to ensure all linked files are available for validation
  // This is necessary because SKILL.md links to agent markdown files in ../agents/
  const resourcesDir = path.resolve(path.dirname(skillPath), '..');
  await registry.crawl({ baseDir: resourcesDir, include: ['**/*.md'] });

  // Validate (no frontmatter schema by default)
  const result = await registry.validate();

  return result;
}

/**
 * Build issues array from validation results
 */
function buildIssuesArray(
  skillPath: string,
  filenameValidation: { valid: boolean; message?: string },
  strictMode: boolean,
  resourceErrors: ResourceValidationResult['issues'],
  skillErrors: ValidationResult['issues'],
  skillWarnings: ValidationResult['issues']
): Array<{
  source: IssueSource;
  severity: IssueSeverity;
  code: string;
  message: string;
  location: string | undefined;
}> {
  const issues: Array<{
    source: IssueSource;
    severity: IssueSeverity;
    code: string;
    message: string;
    location: string | undefined;
  }> = [];

  // Add filename validation issues
  if (!filenameValidation.valid && filenameValidation.message) {
    issues.push({
      source: 'filename',
      severity: strictMode ? 'error' : 'warning',
      code: 'non-standard-filename',
      message: filenameValidation.message,
      location: skillPath,
    });
  }

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
      severity: issue.severity as IssueSeverity,
      code: issue.code,
      message: issue.message,
      location: issue.location,
    });
  }

  return issues;
}

/**
 * Merge resource, skill, and filename validation results
 */
function mergeValidationResults(
  skillPath: string,
  resourceResult: ResourceValidationResult,
  skillResult: ValidationResult,
  filenameValidation: { valid: boolean; message?: string },
  strictMode: boolean
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

  // Count filename issues
  const filenameErrorCount = !filenameValidation.valid && strictMode ? 1 : 0;
  const filenameWarningCount = !filenameValidation.valid && !strictMode ? 1 : 0;

  const totalErrors = resourceErrorCount + skillErrorCount + filenameErrorCount;
  const totalWarnings = skillWarningCount + filenameWarningCount;

  // Build unified issues array
  const issues = buildIssuesArray(
    skillPath,
    filenameValidation,
    strictMode,
    resourceErrors,
    skillErrors,
    skillWarnings
  );

  const baseResult: UnifiedSkillValidationResult = {
    skill: skillName,
    path: skillPath,
    status: totalErrors > 0 ? 'error' : 'success',
    resourceValidation: {
      status: resourceErrorCount > 0 ? 'error' : 'success',
      linksChecked: resourceResult.linksByType ? Object.values(resourceResult.linksByType).reduce((sum, count) => sum + count, 0) : 0,
      errors: resourceErrorCount,
    },
    skillValidation: {
      status: (skillErrorCount + filenameErrorCount) > 0 ? 'error' : 'success',
      errors: skillErrorCount + filenameErrorCount,
      warnings: skillWarningCount + filenameWarningCount,
    },
    totalErrors,
    totalWarnings,
  };

  // Only add issues property if there are issues
  if (issues.length > 0) {
    return { ...baseResult, issues } as UnifiedSkillValidationResult;
  }

  return baseResult;
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
  source: IssueSource;
  severity: IssueSeverity;
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
  // js-yaml has truncation issues with very large objects (>80 results)
  // Use JSON for large outputs to avoid truncation
  if (results.length > 80) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(yaml.dump(output, { indent: 2, lineWidth: -1, noRefs: true }));
  }

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
  user?: boolean;
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
    // Step 1: Determine context and discover skills
    let skillPaths: string[];
    let strictMode: boolean;
    let rootDir: string;

    if (options.user) {
      // User context: scan ~/.claude
      logger.info('🔍 Validating user-installed skills in ~/.claude');
      const { plugins, skills } = await scanUserContext();
      const allResources = [...plugins, ...skills];
      const discoveredSkills = discoverSkills(allResources);
      skillPaths = discoveredSkills.map(s => s.path);
      strictMode = false; // Permissive with warnings
      rootDir = process.cwd(); // Use cwd for resource validation context
    } else {
      // Project context: use resources config
      rootDir = pathArg ?? process.cwd();
      logger.info(`🔍 Validating skills in: ${rootDir}`);

      // Load project config
      const config = loadConfig(rootDir);

      // Use discovery package with config boundaries
      const scanResult = await scan({
        path: rootDir,
        recursive: true,
        include: config.resources?.include ?? ['**/*.md'],
        exclude: config.resources?.exclude ?? [],
      });

      // Filter for skills (case-insensitive discovery)
      const discoveredSkills = discoverSkills(scanResult.results);
      skillPaths = discoveredSkills.map(s => s.path);
      strictMode = true; // Strict errors
    }

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

    // Create GitTracker for efficient git-ignore checking across all skills
    // This caches git operations and avoids spawning hundreds of git subprocesses
    const gitTracker = new GitTracker(rootDir);
    await gitTracker.initialize();

    const results: UnifiedSkillValidationResult[] = [];

    // Step 2: Validate each skill
    for (const skillPath of skillPaths) {
      // 2a: Validate filename
      const filenameCheck = validateSkillFilename(skillPath);

      // 2b: Resource validation (markdown, links)
      const resourceResult = await validateSkillAsResource(skillPath, rootDir, gitTracker);

      // 2c: Skill-specific validation (reserved words, etc.)
      const skillResult = await validateSkill({ skillPath, rootDir });

      // 2d: Merge results
      const unified = mergeValidationResults(
        skillPath,
        resourceResult,
        skillResult,
        filenameCheck,
        strictMode
      );
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

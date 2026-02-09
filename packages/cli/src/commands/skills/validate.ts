/**
 * Skills validate command - validate skills for packaging
 *
 * Validates skills declared in package.json vat.skills using validateSkillForPackaging.
 * Supports validation overrides and expiration checking.
 */

import type { VatSkillMetadata } from '@vibe-agent-toolkit/agent-schema';
import {
  validateSkillForPackaging,
  type PackagingValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import * as yaml from 'js-yaml';

import { formatDurationSecs } from '../../utils/duration.js';
import { type createLogger } from '../../utils/logger.js';

import {
  filterSkillsByName,
  handleCommandError,
  setupCommandContext,
} from './command-helpers.js';
import { readPackageJson, validateSkillSource } from './shared.js';

/**
 * Skills validate command options
 */
export interface SkillsValidateCommandOptions {
  skill?: string;
  debug?: boolean;
  verbose?: boolean;
}

/**
 * Strip excludedReferences from results metadata for non-verbose YAML output.
 * Keeps excludedReferenceCount for summary info, but removes the full path list
 * which can be noisy. Operates on a deep copy to avoid mutating original results.
 */
function stripExcludedReferencePaths(results: PackagingValidationResult[]): unknown[] {
  return results.map((result) => {
    const { skillLines, totalLines, fileCount, directFileCount, maxLinkDepth, excludedReferenceCount } = result.metadata;
    return {
      ...result,
      metadata: { skillLines, totalLines, fileCount, directFileCount, maxLinkDepth, excludedReferenceCount },
    };
  });
}

/**
 * Output YAML summary to stdout
 */
function outputYamlSummary(
  results: PackagingValidationResult[],
  duration: number,
  verbose: boolean
): void {
  const outputResults = verbose ? results : stripExcludedReferencePaths(results);

  const output = {
    status: results.some((r) => r.status === 'error') ? 'error' : 'success',
    skillsValidated: results.length,
    results: outputResults,
    durationSecs: formatDurationSecs(duration),
  };

  console.log(yaml.dump(output, { indent: 2, lineWidth: -1, noRefs: true }));
}

/**
 * Output a single validation error
 */
function outputSingleError(error: {
  code: string;
  message: string;
  location?: string;
  fix?: string;
}): void {
  console.error(`    [${String(error.code)}] ${String(error.message)}`);
  if (error.location) {
    console.error(`      Location: ${String(error.location)}`);
  }
  if (error.fix) {
    console.error(`      Fix: ${String(error.fix)}`);
  }
}

/**
 * Output detailed errors for a skill
 */
function outputSkillErrors(result: PackagingValidationResult): void {
  console.error(`Skill: ${result.skillName}`);

  // Show active errors
  if (result.activeErrors.length > 0) {
    console.error(`  Active errors (${result.activeErrors.length}):`);
    for (const error of result.activeErrors) {
      outputSingleError(error);
    }
  }

  // Show ignored errors (with reasons)
  if (result.ignoredErrors.length > 0) {
    console.error(`  Ignored errors (${result.ignoredErrors.length}):`);
    for (const { error, reason } of result.ignoredErrors) {
      console.error(
        `    [${String(error.code)}] ${String(error.message)} (ignored: ${reason})`
      );
    }
  }

  // Show expired overrides as errors
  if (result.expiredOverrides.length > 0) {
    console.error(`  Expired overrides (${result.expiredOverrides.length}):`);
    for (const { error, reason, expiredDate } of result.expiredOverrides) {
      console.error(`    [${String(error.code)}] ${String(error.message)}`);
      console.error(`      Override expired: ${expiredDate} (reason: ${reason})`);
    }
  }

  console.error('');
}

/**
 * Output validation report to stdout (YAML) and stderr (human-readable)
 */
function outputValidationReport(
  results: PackagingValidationResult[],
  duration: number,
  logger: ReturnType<typeof createLogger>,
  verbose: boolean
): void {
  // Output YAML to stdout (for programmatic parsing)
  outputYamlSummary(results, duration, verbose);

  // Output human-readable summary to stderr
  const failedSkills = results.filter((r) => r.status === 'error');

  if (failedSkills.length === 0) {
    logger.info('\n✅ All validations passed');
    return;
  }

  console.error('\n❌ Validation errors:\n');
  for (const result of failedSkills) {
    outputSkillErrors(result);
  }
}

/**
 * Log error status progress
 */
function logErrorProgress(
  skill: VatSkillMetadata,
  result: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  const activeCount = result.activeErrors.length;
  const ignoredCount = result.ignoredErrors.length;
  const expiredCount = result.expiredOverrides.length;

  if (activeCount > 0) {
    logger.error(`   ❌ ${skill.name}: ${activeCount} error${activeCount === 1 ? '' : 's'}`);
  }
  if (ignoredCount > 0) {
    logger.info(`      (${ignoredCount} ignored by overrides)`);
  }
  if (expiredCount > 0) {
    logger.error(`      (${expiredCount} expired override${expiredCount === 1 ? '' : 's'})`);
  }
}

/**
 * Log success status progress
 */
function logSuccessProgress(
  skill: VatSkillMetadata,
  ignoredCount: number,
  logger: ReturnType<typeof createLogger>
): void {
  if (ignoredCount > 0) {
    logger.info(`   ✅ ${skill.name} (${ignoredCount} ignored by overrides)`);
  } else {
    logger.info(`   ✅ ${skill.name}`);
  }
}

/**
 * Log validation progress for a single skill
 */
function logSkillProgress(
  skill: VatSkillMetadata,
  result: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  if (result.status === 'error') {
    logErrorProgress(skill, result, logger);
  } else {
    logSuccessProgress(skill, result.ignoredErrors.length, logger);
  }
}

/**
 * Validate a single skill
 */
async function validateSingleSkill(
  skill: VatSkillMetadata,
  cwd: string,
  logger: ReturnType<typeof createLogger>
): Promise<PackagingValidationResult> {
  const sourcePath = validateSkillSource(skill, cwd, logger);

  logger.info(`   Validating: ${skill.name}`);
  logger.debug(`   Source: ${skill.source}`);

  const result = await validateSkillForPackaging(sourcePath, skill);
  logSkillProgress(skill, result, logger);

  return result;
}

/**
 * Skills validate command implementation
 */
export async function validateCommand(
  pathArg: string | undefined,
  options: SkillsValidateCommandOptions
): Promise<void> {
  const { logger, cwd, startTime } = setupCommandContext(pathArg, options.debug);

  try {
    // Read package.json and filter skills
    const packageJson = await readPackageJson(cwd);
    const skills = packageJson.vat?.skills ?? [];

    if (skills.length === 0) {
      logger.info('ℹ️  No skills found in package.json vat.skills');
      logger.info('   To add skills, define them in package.json under the vat.skills field');
      process.exit(0);
    }

    const skillsToValidate = filterSkillsByName(skills, options.skill);
    logger.info(`🔍 Found ${skillsToValidate.length} skill(s) to validate\n`);

    // Validate each skill
    const results: PackagingValidationResult[] = [];
    for (const skill of skillsToValidate) {
      const result = await validateSingleSkill(skill, cwd, logger);
      results.push(result);
    }

    // Output report and exit
    const duration = Date.now() - startTime;
    const verbose = options.verbose === true;
    outputValidationReport(results, duration, logger, verbose);

    const hasErrors = results.some(
      (r) => r.activeErrors.length > 0 || r.expiredOverrides.length > 0
    );
    process.exit(hasErrors ? 1 : 0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsValidate');
  }
}

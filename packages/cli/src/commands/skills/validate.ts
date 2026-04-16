/**
 * Skills validate command - validate skills for packaging
 *
 * Discovers skills from config yaml skills.include/exclude, validates each
 * using validateSkillForPackaging with merged packaging config.
 */

import {
  validateSkillForPackaging,
  type PackagingValidationResult,
  type SkillPackagingConfig,
} from '@vibe-agent-toolkit/agent-skills';
import * as yaml from 'js-yaml';

import { loadConfig } from '../../utils/config-loader.js';
import { formatDurationSecs } from '../../utils/duration.js';
import { type createLogger } from '../../utils/logger.js';

import {
  filterSkillsByName,
  handleCommandError,
  setupCommandContext,
  type DiscoveredSkill,
} from './command-helpers.js';
import { discoverSkillsFromConfig } from './skill-discovery.js';

/**
 * Skills validate command options
 */
export interface SkillsValidateCommandOptions {
  skill?: string;
  debug?: boolean;
  verbose?: boolean;
}

/**
 * Discovered skill with merged packaging config for validation
 */
interface ValidatableSkill extends DiscoveredSkill {
  packagingConfig: SkillPackagingConfig;
}

/**
 * Strip excludedReferences from results metadata for non-verbose YAML output.
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

  if (result.activeErrors.length > 0) {
    console.error(`  Active errors (${result.activeErrors.length}):`);
    for (const error of result.activeErrors) {
      outputSingleError(error);
    }
  }

  if (result.ignoredErrors.length > 0) {
    console.error(`  Accepted issues (${result.ignoredErrors.length}):`);
    for (const record of result.ignoredErrors) {
      console.error(
        `    [${String(record.code)}] ${String(record.location)} (accepted: ${record.reason})`
      );
    }
  }

  const expiredWarnings = result.activeWarnings.filter(w => w.code === 'ACCEPTANCE_EXPIRED');
  if (expiredWarnings.length > 0) {
    console.error(`  Expired acceptances (${expiredWarnings.length}):`);
    for (const warn of expiredWarnings) {
      console.error(`    ${String(warn.message)}`);
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
  outputYamlSummary(results, duration, verbose);

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
 * Log validation progress for a single skill
 */
function logSkillProgress(
  skillName: string,
  result: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  if (result.status === 'error') {
    const activeCount = result.activeErrors.length;
    const acceptedCount = result.ignoredErrors.length;
    const expiredCount = result.activeWarnings.filter(w => w.code === 'ACCEPTANCE_EXPIRED').length;

    logger.error(`   ❌ ${skillName}: ${activeCount} error${activeCount === 1 ? '' : 's'}`);
    if (acceptedCount > 0) {
      logger.info(`      (${acceptedCount} accepted by config)`);
    }
    if (expiredCount > 0) {
      logger.error(`      (${expiredCount} expired acceptance${expiredCount === 1 ? '' : 's'})`);
    }
  } else if (result.ignoredErrors.length > 0) {
    logger.info(`   ✅ ${skillName} (${result.ignoredErrors.length} accepted by config)`);
  } else {
    logger.info(`   ✅ ${skillName}`);
  }
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
    // Load config yaml from cwd (not workspace root — config lives next to the package)
    const config = loadConfig(cwd);

    if (!config?.skills) {
      logger.info('No skills section in config yaml — nothing to validate');
      process.exit(0);
    }

    // Discover skills from config yaml (relative to cwd where config lives)
    const discovered = await discoverSkillsFromConfig(config.skills, cwd);

    if (discovered.length === 0) {
      logger.info('ℹ️  No skills found matching config yaml skills.include patterns');
      process.exit(0);
    }

    // Merge packaging config for each skill.
    // Strip undefined values from the spread to satisfy exactOptionalPropertyTypes —
    // Zod-inferred optional types produce explicit `undefined` which is not assignable
    // to optional-but-not-undefined properties.
    const { defaults, config: perSkillConfig } = config.skills;
    const validatableSkills: ValidatableSkill[] = discovered.map(skill => {
      const merged = { ...defaults, ...perSkillConfig?.[skill.name] };
      const packagingConfig: SkillPackagingConfig = {};
      for (const [key, value] of Object.entries(merged)) {
        if (value !== undefined) {
          (packagingConfig as Record<string, unknown>)[key] = value;
        }
      }
      return { ...skill, packagingConfig };
    });

    // Filter by name if specified
    const skillsToValidate = filterSkillsByName(validatableSkills, options.skill);
    logger.info(`🔍 Found ${skillsToValidate.length} skill(s) to validate\n`);

    // Validate each skill
    const results: PackagingValidationResult[] = [];
    for (const skill of skillsToValidate) {
      logger.info(`   Validating: ${skill.name}`);
      logger.debug(`   Source: ${skill.sourcePath}`);

      const result = await validateSkillForPackaging(skill.sourcePath, skill.packagingConfig);
      logSkillProgress(skill.name, result, logger);
      results.push(result);
    }

    // Output report and exit
    const duration = Date.now() - startTime;
    const verbose = options.verbose === true;
    outputValidationReport(results, duration, logger, verbose);

    const hasErrors = results.some(r => r.status === 'error');
    process.exit(hasErrors ? 1 : 0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsValidate');
  }
}

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
  type SkillValidationSharedContext,
} from '@vibe-agent-toolkit/agent-skills';
import type { Target } from '@vibe-agent-toolkit/claude-marketplace';
import { ResourceRegistry } from '@vibe-agent-toolkit/resources';
import { findProjectRoot, gitFindRoot, GitTracker, safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'js-yaml';

import { loadConfig } from '../../utils/config-loader.js';
import { formatDurationSecs } from '../../utils/duration.js';
import { type createLogger } from '../../utils/logger.js';
import { mergeSkillPackagingConfig } from '../../utils/skill-packaging-config.js';
import { renderSkillQualityFooter } from '../../utils/skill-quality-footer.js';
import { applyConfigVerdicts } from '../../utils/verdict-helpers.js';

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
    console.error(`  Allowed issues (${result.ignoredErrors.length}):`);
    for (const record of result.ignoredErrors) {
      console.error(
        `    [${String(record.code)}] ${String(record.location)} (allowed: ${record.reason})`
      );
    }
  }

  const expiredWarnings = result.activeWarnings.filter(w => w.code === 'ALLOW_EXPIRED');
  if (expiredWarnings.length > 0) {
    console.error(`  Expired allow entries (${expiredWarnings.length}):`);
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

  // Collect all emitted codes across skills (both errors and warnings) to drive the footer
  const emittedCodes = new Set<string>();
  for (const r of results) {
    for (const issue of r.allErrors) {
      emittedCodes.add(issue.code);
    }
  }
  const hasSkillFindings = results.some(
    (r) => r.activeErrors.length > 0 || r.activeWarnings.length > 0,
  );

  if (failedSkills.length === 0) {
    logger.info('\n✅ All validations passed');
    renderSkillQualityFooter(logger, hasSkillFindings, emittedCodes);
    return;
  }

  console.error('\n❌ Validation errors:\n');
  for (const result of failedSkills) {
    outputSkillErrors(result);
  }
  renderSkillQualityFooter(logger, hasSkillFindings, emittedCodes);
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
    const allowedCount = result.ignoredErrors.length;
    const expiredCount = result.activeWarnings.filter(w => w.code === 'ALLOW_EXPIRED').length;

    logger.error(`   ❌ ${skillName}: ${activeCount} error${activeCount === 1 ? '' : 's'}`);
    if (allowedCount > 0) {
      logger.info(`      (${allowedCount} allowed by config)`);
    }
    if (expiredCount > 0) {
      logger.error(`      (${expiredCount} expired allow entr${expiredCount === 1 ? 'y' : 'ies'})`);
    }
  } else if (result.ignoredErrors.length > 0) {
    logger.info(`   ✅ ${skillName} (${result.ignoredErrors.length} allowed by config)`);
  } else {
    logger.info(`   ✅ ${skillName}`);
  }
}

/**
 * Build a single shared validation context for an entire `vat skills validate`
 * invocation.
 *
 * When every skill in the batch resolves to the same projectRoot (the normal
 * monorepo case), we crawl the resource registry once and hand the same
 * instance to each skill's validation — the per-skill markdown reparse
 * disappears. Similarly, gitignore checks are backed by a single
 * {@link GitTracker} when every skill sits inside the same git repository.
 *
 * When the batch is heterogeneous (e.g. multiple projectRoots), the helper
 * returns an empty context and validators transparently fall back to their
 * legacy per-skill setup — correctness first, perf second.
 */
async function buildSharedValidationContext(
  skills: ValidatableSkill[],
  logger: ReturnType<typeof createLogger>,
): Promise<SkillValidationSharedContext> {
  if (skills.length === 0) {
    return {};
  }

  const projectRoots = new Set<string>();
  const gitRoots = new Set<string>();
  for (const skill of skills) {
    const skillDir = safePath.resolve(skill.sourcePath, '..');
    projectRoots.add(findProjectRoot(skillDir));
    const gitRoot = gitFindRoot(skillDir);
    if (gitRoot !== null) {
      gitRoots.add(safePath.resolve(gitRoot));
    }
  }

  const context: SkillValidationSharedContext = {};

  // Only reuse a single registry when every skill shares the same project
  // root. Otherwise the per-skill fallback path is correct and the cost is
  // unchanged from the pre-refactor baseline.
  if (projectRoots.size === 1) {
    const [sharedRoot] = [...projectRoots];
    if (sharedRoot !== undefined) {
      logger.debug(`Building shared resource registry rooted at: ${sharedRoot}`);
      const registry = await ResourceRegistry.fromCrawl({
        baseDir: sharedRoot,
        include: ['**/*.md'],
      });
      registry.resolveLinks();
      context.registry = registry;
    }
  } else {
    logger.debug(`Skipping shared registry — batch spans ${projectRoots.size} project roots`);
  }

  // One tracker per repo; when the batch spans repos, skip rather than spawn
  // multiple `git ls-files`.
  if (gitRoots.size === 1) {
    const [sharedGitRoot] = [...gitRoots];
    if (sharedGitRoot !== undefined) {
      logger.debug(`Building shared GitTracker rooted at: ${sharedGitRoot}`);
      const tracker = new GitTracker(sharedGitRoot);
      await tracker.initialize();
      context.gitTracker = tracker;
    }
  } else if (gitRoots.size > 1) {
    logger.debug(`Skipping shared tracker — batch spans ${gitRoots.size} git roots`);
  }

  return context;
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
    const { defaults, config: perSkillConfig } = config.skills;
    const validatableSkills: ValidatableSkill[] = discovered.map(skill => ({
      ...skill,
      packagingConfig: mergeSkillPackagingConfig(
        defaults as Record<string, unknown> | undefined,
        perSkillConfig?.[skill.name] as Record<string, unknown> | undefined,
      ),
    }));

    // Filter by name if specified
    const skillsToValidate = filterSkillsByName(validatableSkills, options.skill);
    logger.info(`🔍 Found ${skillsToValidate.length} skill(s) to validate\n`);

    // Build shared context once per invocation. Both the resource registry
    // (for markdown parses) and the git tracker (for gitignore checks) can be
    // shared across every skill whose projectRoot + gitRoot match the derived
    // values, which is the common case for a single-repo `vat skills validate`.
    const sharedContext = await buildSharedValidationContext(skillsToValidate, logger);

    // Validate each skill
    const results: PackagingValidationResult[] = [];
    for (const skill of skillsToValidate) {
      logger.info(`   Validating: ${skill.name}`);
      logger.debug(`   Source: ${skill.sourcePath}`);

      const result = await validateSkillForPackaging(
        skill.sourcePath,
        skill.packagingConfig,
        'source',
        sharedContext,
      );
      applyConfigVerdicts(result, skill.packagingConfig.targets as readonly Target[] | undefined, skill.sourcePath);
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

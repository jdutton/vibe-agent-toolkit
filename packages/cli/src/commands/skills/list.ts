/**
 * List skills in project or user installation
 *
 * By default, lists project skills. Use --user flag to list user-installed skills.
 */

import * as path from 'node:path';

import { scan, type ScanSummary } from '@vibe-agent-toolkit/discovery';

import { loadConfig } from '../../utils/config-loader.js';
import { createLogger } from '../../utils/logger.js';
import { discoverSkills, validateSkillFilename } from '../../utils/skill-discovery.js';
import { scanUserContext } from '../../utils/user-context-scanner.js';

export interface SkillsListCommandOptions {
  user?: boolean;
  verbose?: boolean;
  debug?: boolean;
}

interface DiscoveredSkill {
  name: string;
  path: string;
  valid: boolean;
  warning?: string;
}

/**
 * Extract skill name from SKILL.md path
 */
function extractSkillName(skillPath: string): string {
  // Extract skill name from path (directory name containing SKILL.md)
  const dir = path.dirname(skillPath);
  return path.basename(dir);
}

/**
 * Convert discovered skills to DiscoveredSkill format with validation
 */
function processDiscoveredSkills(
  discoveredSkills: Array<{ path: string }>
): DiscoveredSkill[] {
  return discoveredSkills.map(s => {
    const filenameCheck = validateSkillFilename(s.path);
    const skill: DiscoveredSkill = {
      path: s.path,
      name: extractSkillName(s.path),
      valid: filenameCheck.valid,
    };
    // Only add warning if it exists (exactOptionalPropertyTypes)
    if (filenameCheck.message !== undefined) {
      skill.warning = filenameCheck.message;
    }
    return skill;
  });
}

/**
 * Output skills as YAML
 */
function outputSkillsYaml(skills: DiscoveredSkill[], context: string): void {
  process.stdout.write('---\n');
  process.stdout.write(`status: success\n`);
  process.stdout.write(`context: ${context}\n`);
  process.stdout.write(`skillsFound: ${skills.length}\n`);
  process.stdout.write(`skills:\n`);

  for (const skill of skills) {
    process.stdout.write(`  - name: ${skill.name}\n`);
    process.stdout.write(`    path: ${skill.path}\n`);
    process.stdout.write(`    valid: ${skill.valid}\n`);

    if (skill.warning) {
      process.stdout.write(`    warning: "${skill.warning}"\n`);
    }
  }
}

/**
 * Output human-readable skill list
 */
function outputSkillsHuman(
  skills: DiscoveredSkill[],
  logger: ReturnType<typeof createLogger>,
  options: SkillsListCommandOptions
): void {
  if (skills.length === 0) {
    logger.info(`\n   No skills found`);
    return;
  }

  logger.info(`\n   Found ${skills.length} skill${skills.length === 1 ? '' : 's'}:\n`);

  for (const skill of skills) {
    const statusIcon = skill.valid ? '✅' : '⚠️';
    const displayName = skill.name;

    if (options.verbose) {
      logger.info(`   ${statusIcon} ${displayName}`);
      if (skill.warning) {
        logger.info(`      Warning: ${skill.warning}`);
      }
      logger.info(`      Path: ${skill.path}\n`);
    } else if (skill.warning) {
      logger.info(`   ${statusIcon} ${displayName} (${skill.warning})`);
    } else {
      logger.info(`   ${statusIcon} ${displayName}`);
    }
  }
}

export async function listCommand(
  pathArg: string | undefined,
  options: SkillsListCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});

  try {
    let skills: DiscoveredSkill[];
    let context: string;

    if (options.user) {
      // User context: scan ~/.claude
      logger.info('📋 Listing user-installed skills');

      const { plugins, skills: standaloneSkills } = await scanUserContext();
      const allResources = [...plugins, ...standaloneSkills];
      const discoveredSkills = discoverSkills(allResources);
      skills = processDiscoveredSkills(discoveredSkills);
      context = 'user';
    } else {
      // Project context: use resources config
      const rootDir = pathArg ?? process.cwd();
      logger.info(`📋 Listing skills in: ${rootDir}`);

      const config = loadConfig(rootDir);

      const scanResult: ScanSummary = await scan({
        path: rootDir,
        recursive: true,
        include: config.resources?.include ?? [],
        exclude: config.resources?.exclude ?? [],
      });

      const discoveredSkills = discoverSkills(scanResult.results);
      skills = processDiscoveredSkills(discoveredSkills);
      context = 'project';
    }

    // Output YAML to stdout
    outputSkillsYaml(skills, context);

    // Human-friendly output to stderr
    outputSkillsHuman(skills, logger, options);

    process.exit(0);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to list skills: ${errorMessage}`);
    process.exit(2);
  }
}

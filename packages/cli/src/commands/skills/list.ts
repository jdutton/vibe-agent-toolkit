/**
 * List skills in project or user installation
 *
 * By default, lists project skills. Use --user flag to list user-installed skills.
 * Supports npm:@scope/pkg and local .tgz/.tar.gz sources for inspecting packages
 * without installing them.
 */

import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { scan, type ScanSummary } from '@vibe-agent-toolkit/discovery';
import { safePath } from '@vibe-agent-toolkit/utils';

import { loadConfig } from '../../utils/config-loader.js';
import { createLogger } from '../../utils/logger.js';
import { discoverSkills, validateSkillFilename } from '../../utils/skill-discovery.js';
import { scanUserContext } from '../../utils/user-context-scanner.js';

import { isNpmOrTarballSource, resolveNpmOrTarballSource } from './source-resolvers.js';

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
  const dir = dirname(skillPath);
  return basename(dir);
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

/**
 * Scan a dist/skills/ directory tree for SKILL.md files and return DiscoveredSkill[].
 * Each immediate subdirectory that contains a SKILL.md is treated as one skill.
 */
function scanSkillsDir(skillsDir: string): DiscoveredSkill[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp path from trusted source
  const entries = readdirSync(skillsDir, { withFileTypes: true });
  const skills: DiscoveredSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = safePath.join(skillsDir, entry.name);
    const skillMd = safePath.join(candidate, 'SKILL.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from temp path
    if (existsSync(skillMd)) {
      const filenameCheck = validateSkillFilename(skillMd);
      const skill: DiscoveredSkill = {
        path: skillMd,
        name: entry.name,
        valid: filenameCheck.valid,
      };
      if (filenameCheck.message !== undefined) {
        skill.warning = filenameCheck.message;
      }
      skills.push(skill);
    }
  }

  return skills;
}

/**
 * List skills from an npm: or .tgz/.tar.gz source without installing.
 */
async function listFromNpmSource(
  source: string,
  logger: ReturnType<typeof createLogger>,
  options: SkillsListCommandOptions,
): Promise<void> {
  logger.info(`📋 Inspecting npm/tgz source: ${source}`);

  const resolved = await resolveNpmOrTarballSource(source);

  try {
    const skills = scanSkillsDir(resolved.skillsDir);
    outputSkillsYaml(skills, 'npm');
    outputSkillsHuman(skills, logger, options);
    process.exit(0);
  } finally {
    for (const dir of resolved.tempDirs) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export async function listCommand(
  pathArg: string | undefined,
  options: SkillsListCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});

  try {
    // npm: or .tgz/.tar.gz source — inspect without installing
    if (pathArg !== undefined && isNpmOrTarballSource(pathArg)) {
      await listFromNpmSource(pathArg, logger, options);
      return; // process.exit(0) called inside listFromNpmSource
    }

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
        include: config?.resources?.include ?? [],
        exclude: config?.resources?.exclude ?? [],
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

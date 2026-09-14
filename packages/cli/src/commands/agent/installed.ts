/**
 * List installed agents command
 */

import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';
import yaml from 'yaml';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { SCOPE_LOCATIONS } from '../../utils/scope-locations.js';

export interface InstalledCommandOptions {
  scope?: 'user' | 'project' | 'all';
  runtime?: string;
  debug?: boolean;
}

interface InstalledSkill {
  name: string;
  scope: string;
  type: 'installed' | 'symlink';
  path: string;
}

/**
 * List installed agents command
 */
export async function installedCommand(options: InstalledCommandOptions): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const { runtime = 'agent-skill', scope = 'all' } = options;

    const scopeLocations = SCOPE_LOCATIONS[runtime];
    if (!scopeLocations) {
      throw new Error(`Runtime '${runtime}' not implemented`);
    }

    // Determine which scopes to scan
    const scopesToScan =
      scope === 'all' ? Object.keys(scopeLocations) : [scope];

    const skills = await scanForInstalledSkills(scopeLocations, scopesToScan);

    if (skills.length === 0) {
      logger.info('No installed skills found');
      const duration = Date.now() - startTime;
      logger.debug(`List completed in ${duration}ms`);

      // Output YAML for programmatic parsing
      const output = {
        status: 'success',
        skills: [],
        scanned: scopesToScan,
        duration,
      };
      console.log(yaml.stringify(output));

      process.exit(ExitCode.OK);
      return;
    }

    // Output to stderr (human-readable)
    logger.info('\nInstalled Skills:\n');
    for (const skill of skills) {
      const typeIndicator = skill.type === 'symlink' ? '→' : '✓';
      logger.info(`  ${typeIndicator} ${skill.name} (${skill.scope})`);
      if (skill.type === 'symlink') {
        logger.info(`    ${skill.path}`);
      }
    }
    logger.info('');

    const duration = Date.now() - startTime;
    logger.debug(`List completed in ${duration}ms`);

    // Output YAML to stdout for programmatic parsing
    const output = {
      status: 'success',
      skills: skills.map((s) => ({
        name: s.name,
        scope: s.scope,
        type: s.type,
        path: s.path,
      })),
      scanned: scopesToScan,
      duration,
    };
    console.log(yaml.stringify(output));

    process.exit(ExitCode.OK);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Installed');
  }
}

/**
 * Scan locations for installed skills
 */
async function scanForInstalledSkills(
  scopeLocations: Record<string, string>,
  scopesToScan: string[]
): Promise<InstalledSkill[]> {
  const skills: InstalledSkill[] = [];

  for (const currentScope of scopesToScan) {
    const location = scopeLocations[currentScope];
    if (!location) continue;

    const entries = await listScopeLocation(location);
    if (entries === null) continue;

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      const skillPath = safePath.join(location, entry.name);
      const stats = await fs.lstat(skillPath);
      const isSymlink = stats.isSymbolicLink();

      skills.push({
        name: entry.name,
        scope: currentScope,
        type: isSymlink ? 'symlink' : 'installed',
        path: skillPath,
      });
    }
  }

  return skills;
}

/**
 * The entries of one scope location, or `null` when there is no such directory.
 *
 * Only an ABSENCE is `null`. A scope directory the OS refuses to list is not an
 * empty one, and reading it as empty would list fewer installs than there are.
 */
async function listScopeLocation(location: string): Promise<Dirent[] | null> {
  try {
    return await fs.readdir(location, { withFileTypes: true });
  } catch (error) {
    if (isPathAbsentError(error)) return null;
    throw error;
  }
}

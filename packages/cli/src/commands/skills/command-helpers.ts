/**
 * Helper functions for skill commands
 */

import { resolve } from 'node:path';

import { createLogger, type Logger } from '../../utils/logger.js';

/**
 * Handle command errors consistently
 *
 * @param error - Error object
 * @param logger - Logger instance
 * @param startTime - Command start timestamp
 * @param commandName - Name of command for error messages
 */
export function handleCommandError(
  error: unknown,
  logger: Logger,
  startTime: number,
  commandName: string
): never {
  const duration = Date.now() - startTime;

  if (error instanceof Error) {
    logger.error(`${commandName} failed: ${error.message}`);
    logger.debug(`Error stack: ${error.stack ?? 'No stack trace'}`);
  } else {
    logger.error(`${commandName} failed: ${String(error)}`);
  }

  logger.debug(`Duration: ${duration}ms`);

  // Exit with code 2 for unexpected errors
  process.exit(2);
}

/**
 * Discovered skill with its source path and frontmatter name
 */
export interface DiscoveredSkill {
  /** Skill name from SKILL.md frontmatter */
  name: string;
  /** Absolute path to SKILL.md */
  sourcePath: string;
}

/**
 * Filter discovered skills by name if specified
 *
 * @param skills - All discovered skills
 * @param skillName - Optional skill name to filter by
 * @returns Filtered skills array
 * @throws Error if skillName specified but not found
 */
export function filterSkillsByName<T extends DiscoveredSkill>(
  skills: T[],
  skillName?: string
): T[] {
  if (!skillName) {
    return skills;
  }

  const filtered = skills.filter(s => s.name === skillName);

  if (filtered.length === 0) {
    const available = skills.map(s => s.name).join(', ');
    throw new Error(
      `Skill "${skillName}" not found. Available skills: ${available}`
    );
  }

  return filtered;
}

/**
 * Write YAML header to stdout
 *
 * @param fields - Key-value pairs to write as YAML
 */
export function writeYamlHeader(fields: Record<string, string | number | boolean>): void {
  process.stdout.write('---\n');
  for (const [key, value] of Object.entries(fields)) {
    process.stdout.write(`${key}: ${value}\n`);
  }
}

/**
 * Command context setup
 */
export interface CommandContext {
  logger: Logger;
  cwd: string;
  startTime: number;
}

/**
 * Setup command context (logger, cwd, timing)
 *
 * @param pathArg - Optional path argument
 * @param debug - Enable debug logging
 * @returns Command context
 */
export function setupCommandContext(
  pathArg: string | undefined,
  debug?: boolean
): CommandContext {
  const logger = createLogger(debug ? { debug: true } : {});
  const startTime = Date.now();
  const cwd = pathArg ? resolve(pathArg) : process.cwd();

  return { logger, cwd, startTime };
}

/**
 * List installed agents command
 */

import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';

import { materializeIssue } from '@vibe-agent-toolkit/agent-skills';
import { buildReport, toFindings, type Gate, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { isPathAbsentError, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { SCOPE_LOCATIONS } from '../../utils/scope-locations.js';

import type { AgentInstalledData, AgentInstalledReport } from './installed-schema.js';

export interface InstalledCommandOptions {
  scope?: string;
  runtime?: string;
  debug?: boolean;
}

type InstalledSkill = AgentInstalledData['skills'][number];

/** `vat agent installed` has no `--strict`; an unreadable scope is a warning: the gate is fixed. */
const GATE: Gate = { strict: false };

/** The `--scope` value that scans every scope the runtime has. */
const ALL_SCOPES = 'all';

/**
 * List installed agents command
 */
export async function installedCommand(options: InstalledCommandOptions): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  let report: AgentInstalledReport;
  try {
    const { runtime = 'agent-skill', scope = ALL_SCOPES } = options;
    const scopeLocations = scopeLocationsFor(runtime);
    const scopesToScan = scopesFor(scope, scopeLocations);

    const { skills, unreadable } = await scanForInstalledSkills(scopeLocations, scopesToScan);
    logInstalledSkills(skills, logger);

    report = buildReport({
      examined: scopesToScan.length,
      findings: toFindings(unreadable),
      data: { scanned: scopesToScan, skills },
      gate: GATE,
      durationMs: Date.now() - startTime,
    });
  } catch (error) {
    endWithRefusal('agent installed', refusalCodeOf(error), error, 'yaml', GATE, NOTHING_FINISHED);
  }
  endWithReport('agent installed', report, 'yaml');
}

/** The scope directories of `runtime`, or the invocation's mistake. */
function scopeLocationsFor(runtime: string): Record<string, string> {
  const scopeLocations = SCOPE_LOCATIONS[runtime];
  if (!scopeLocations) {
    throw new CommandRefusalError('USAGE_INVALID', `Unknown runtime '${runtime}' (known: ${Object.keys(SCOPE_LOCATIONS).join(', ')})`);
  }
  return scopeLocations;
}

/** The scopes `--scope` names, or the invocation's mistake. */
function scopesFor(scope: string, scopeLocations: Record<string, string>): string[] {
  const known = Object.keys(scopeLocations);
  if (scope === ALL_SCOPES) return known;
  if (!known.includes(scope)) {
    throw new CommandRefusalError('USAGE_INVALID', `Unknown scope '${scope}' (known: ${[ALL_SCOPES, ...known].join(', ')})`);
  }
  return [scope];
}

/** The human listing, on stderr. */
function logInstalledSkills(skills: readonly InstalledSkill[], logger: Logger): void {
  if (skills.length === 0) {
    logger.info('No installed skills found');
    return;
  }
  logger.info('\nInstalled Skills:\n');
  for (const skill of skills) {
    logger.info(`  ${skill.type === 'symlink' ? '→' : '✓'} ${skill.name} (${skill.scope})`);
    if (skill.type === 'symlink') logger.info(`    ${skill.path}`);
  }
  logger.info('');
}

/**
 * Scan locations for installed skills. A scope directory the OS will not list
 * is a `SCAN_PATH_UNREADABLE` warning, and the other scopes are still listed.
 */
async function scanForInstalledSkills(
  scopeLocations: Record<string, string>,
  scopesToScan: readonly string[]
): Promise<{ skills: InstalledSkill[]; unreadable: ValidationIssue[] }> {
  const skills: InstalledSkill[] = [];
  const unreadable: ValidationIssue[] = [];

  for (const currentScope of scopesToScan) {
    const location = scopeLocations[currentScope];
    if (!location) continue;

    const listing = await listScopeLocation(location);
    if (listing === null) continue;
    if (!Array.isArray(listing)) {
      unreadable.push(unlistableScopeFinding(currentScope, location, listing.errno));
      continue;
    }

    skills.push(...installedSkillsIn(listing, currentScope, location));
  }

  return { skills, unreadable };
}

/** The installs in one scope's listing: each directory, or link, directly under it. */
function installedSkillsIn(listing: readonly Dirent[], scope: string, location: string): InstalledSkill[] {
  return listing
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      scope,
      type: entry.isSymbolicLink() ? 'symlink' : 'directory',
      path: safePath.join(location, entry.name),
    }));
}

/**
 * The entries of one scope location; `null` when there is no such directory;
 * the errno when the OS refuses to list it.
 *
 * Only an ABSENCE is `null`. A scope directory the OS refuses to list is not an
 * empty one, and reading it as empty would list fewer installs than there are.
 */
async function listScopeLocation(location: string): Promise<Dirent[] | null | { errno: string }> {
  try {
    return await fs.readdir(location, { withFileTypes: true });
  } catch (error) {
    if (isPathAbsentError(error)) return null;
    return { errno: (error as NodeJS.ErrnoException).code ?? 'unknown error' };
  }
}

/**
 * The warning for a scope directory the listing could not read: the list is
 * then a floor. A finding's `location` is relative, and this document has no
 * one root — the scopes live under `$HOME` and under the working directory —
 * so it is the directory relative to its scope's base (`.claude/skills`, the
 * last two segments of every `SCOPE_LOCATIONS` entry). Two scopes read the
 * same location, so `field` is the scope name; the detail adds the full path.
 */
function unlistableScopeFinding(scope: string, location: string, errno: string): ValidationIssue {
  const where = toForwardSlash(safePath.relative(safePath.resolve(location, '..', '..'), location));
  return materializeIssue('SCAN_PATH_UNREADABLE', {
    location: where,
    // Every scope's directory is `.claude/skills` under its own base: the scope says which.
    field: scope,
    detail: `${scope} scope ${toForwardSlash(location)}: listing was refused with ${errno}; any skill installed beneath it is missing from this list`,
  });
}

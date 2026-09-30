/**
 * Install agent to Agent Skills directory
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadAgentManifest } from '@vibe-agent-toolkit/agent-config';
import { codedUserStateWrite } from '@vibe-agent-toolkit/claude-marketplace';
import { buildReport, type Gate } from '@vibe-agent-toolkit/schema';
import { copyDirectory, isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';

import { resolveAgentPath } from '../../utils/agent-discovery.js';
import { CommandRefusalError, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { pathPresent, unstatablePathRefusal } from '../../utils/project-root-policy.js';
import { validateAndGetScopeLocation } from '../../utils/scope-locations.js';

import { agentInstallPath } from './install-path.js';
import type { AgentInstallData } from './install-schema.js';

export interface InstallOptions {
  scope?: 'user' | 'project';
  dev?: boolean;
  force?: boolean;
  runtime?: string;
  debug?: boolean;
}

/** `vat agent install` has no `--strict`, and an install carries no finding: the gate is fixed. */
const GATE: Gate = { strict: false };

/**
 * Install agent command.
 *
 * Every refusal publishes NOTHING_FINISHED: the one unit of work is the
 * install, and a run that refused did not install. A `--force` run that
 * removed the previous install before its copy failed says so in the message —
 * the one thing it did finish, which `data` has no field for.
 */
export async function installAgent(
  agentName: string,
  options: InstallOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  let data: AgentInstallData;
  try {
    data = await install(agentName, options, logger);
  } catch (error) {
    return endWithRefusal('agent install', refusalCodeOf(error), error, 'yaml', GATE, NOTHING_FINISHED);
  }
  logger.debug(`Install completed in ${Date.now() - startTime}ms`);
  endWithReport('agent install', buildReport({ examined: 1, findings: [], data, gate: GATE, durationMs: Date.now() - startTime }), 'yaml');
}

/** The install itself; every throw carries the refusal code of its cause. */
async function install(agentName: string, options: InstallOptions, logger: Logger): Promise<AgentInstallData> {
  const { runtime = 'agent-skill', scope = 'user', dev = false, force = false } = options;

  if (dev && process.platform === 'win32') {
    throw new CommandRefusalError(
      'NOT_IMPLEMENTED',
      '--dev (symlink) not supported on Windows.\n' +
        'Use copy mode (omit --dev) or WSL for development.'
    );
  }

  const targetLocation = validateAndGetScopeLocation(runtime, scope);

  // Refused by name before anything is examined — before the agent is even
  // looked up: with `--force` this path is `rm -rf`'d, and the positional is
  // the one thing on it the user typed.
  const installPath = agentInstallPath(targetLocation, agentName);

  const builtSkillPath = await findBuiltSkill(agentName, runtime, logger);

  await codedUserStateWrite(`create ${targetLocation}`, () => fs.mkdir(targetLocation, { recursive: true }));

  // `'entry'` (lstat), not a following probe: a dangling dev-mode link — what
  // `build:clean` orphans by deleting `dist/` under a previous `--dev` install —
  // is an entry, and `--force` must clear it or `fs.symlink` rejects with EEXIST.
  // A probe the OS refuses is INPUT_UNREADABLE, never "not installed".
  const replacing = pathPresent(installPath, 'entry');
  if (replacing) {
    if (!force) {
      throw new CommandRefusalError('USAGE_INVALID', `${agentName} already installed at ${installPath}\nUse --force to overwrite`);
    }
    await codedUserStateWrite(`remove the existing install at ${installPath}`, () => fs.rm(installPath, { recursive: true, force: true }));
  }
  const removed = replacing ? ' (the previous install there was already removed)' : '';

  if (dev) {
    await codedUserStateWrite(`link ${installPath}${removed}`, () => linkForDevelopment(builtSkillPath, installPath));
    logger.info(`✓ Symlinked ${agentName} to ${installPath} (dev mode)`);
    logger.info(`  Rebuild agent to see changes immediately`);
  } else {
    await codedUserStateWrite(`copy ${builtSkillPath} to ${installPath}${removed}`, () => copyDirectory(builtSkillPath, installPath));
    logger.info(`✓ Installed ${agentName} to ${installPath}`);
  }

  return { agent: agentName, installPath, symlink: dev };
}

/**
 * Symlink a built bundle into place for `--dev`, failing legibly where the OS
 * refuses.
 *
 * ⚠️ **This is POSIX-only in practice, and not by anything written here.**
 * `installAgent` refuses `dev` on win32 before this is reachable, naming WSL
 * and copy mode. So Windows never gets this far, and any Windows-specific
 * handling added here would be dead code — an earlier revision added exactly
 * that, relabelling a `SeCreateSymbolicLinkPrivilege` EPERM that cannot occur.
 * If `--dev` is ever to work on Windows, the change belongs at that guard (a
 * junction takes no elevation, as `dev-tools/src/link-workspace-packages.ts`
 * already does), not in this catch.
 *
 * Deliberately does NOT fall back to copying. `--dev` exists so a rebuild is
 * picked up live; a copy that reported success would leave someone editing
 * sources and wondering why nothing changes — a silent wrong answer in place of
 * a loud, correct refusal.
 *
 * @param builtSkillPath - Absolute path to the built bundle
 * @param installPath - Where the link should be created
 * @throws When the link cannot be created, naming the remedy (the caller
 *   codes it as a failed user-state write)
 */
async function linkForDevelopment(builtSkillPath: string, installPath: string): Promise<void> {
  try {
    // eslint-disable-next-line local/no-bare-symlink-in-tests -- eyes open: win32 is refused by the guard in `installAgent` before this runs, so the Windows privilege hazard the rule names cannot be reached here.
    await fs.symlink(builtSkillPath, installPath, 'dir');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not create the dev-mode symlink at ${installPath}: ${detail}\n` +
        `Re-run with --force to replace whatever is already at ${installPath}, ` +
        'or install without --dev to copy the bundle instead of linking it.',
    );
  }
}

/**
 * Find built skill bundle
 */
async function findBuiltSkill(
  agentName: string,
  runtime: string,
  logger: Logger
): Promise<string> {
  // Resolve agent path
  const agentPath = await resolveAgentPath(agentName, logger);
  const manifest = await loadAgentManifest(agentPath);

  // Find package root by walking up from manifest path
  const packageRoot = await findAgentPackageRoot(manifest.__manifestPath ?? agentPath);

  // Runtime-specific bundle location
  const runtimeDir = runtime === 'agent-skill' ? 'skill' : runtime;
  const builtPath = safePath.join(
    packageRoot,
    'dist',
    'vat-bundles',
    runtimeDir,
    manifest.metadata.name
  );

  // Only an absence is "not built"; a probe the OS refuses is its own INPUT_UNREADABLE.
  if (!pathPresent(builtPath, 'follow')) {
    throw new CommandRefusalError(
      'INPUT_UNREADABLE',
      `Built skill not found at ${builtPath}\n` +
        `Run: vat agent build ${agentName} --runtime ${runtime}`
    );
  }
  return builtPath;
}

/**
 * Find the agent package root (directory containing package.json)
 */
async function findAgentPackageRoot(manifestPath: string): Promise<string> {
  let currentDir = path.dirname(safePath.resolve(manifestPath));

  // Walk up until we find a package.json or hit the filesystem root
  while (currentDir !== path.dirname(currentDir)) {
    const packageJsonPath = safePath.join(currentDir, 'package.json');
    try {
      await fs.access(packageJsonPath);
      return currentDir;
    } catch (error) {
      // No manifest at this level: climb. A refused ancestor is not "no
      // manifest": the input's refusal.
      if (!isPathAbsentError(error)) throw unstatablePathRefusal(packageJsonPath, error);
      currentDir = path.dirname(currentDir);
    }
  }

  throw new CommandRefusalError(
    'USAGE_INVALID',
    `Could not find package.json for agent at ${manifestPath}. ` +
      `Agent must be within an npm package to install.`
  );
}


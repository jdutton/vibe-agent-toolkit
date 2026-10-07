/**
 * Install agent to Agent Skills directory
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadAgentManifest } from '@vibe-agent-toolkit/agent-config';
import { codedUserStateWrite, replaceDirectoryWith } from '@vibe-agent-toolkit/claude-marketplace';
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

/** The owner's read, write and search bits, kept on every install root so its owner can always remove it. */
const OWNER_RWX = 0o700;

/** `vat agent install` has no `--strict`, and an install carries no finding: the gate is fixed. */
const GATE: Gate = { strict: false };

/**
 * Install agent command.
 *
 * Every refusal publishes NOTHING_FINISHED: the one unit of work is the
 * install, and a run that refused did not install. A copy replaces a previous
 * install only once it is whole, so a refused copy leaves that install as it
 * was. A `--force --dev` run removes the previous install before linking, and a
 * failed link says so in the message — the one thing it did finish, which
 * `data` has no field for.
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
  if (replacing && !force) {
    throw new CommandRefusalError('USAGE_INVALID', `${agentName} already installed at ${installPath}\nUse --force to overwrite`);
  }

  if (dev) {
    if (replacing) {
      await codedUserStateWrite(`remove the existing install at ${installPath}`, () => fs.rm(installPath, { recursive: true, force: true }));
    }
    const removed = replacing ? ' (the previous install there was already removed)' : '';
    await codedUserStateWrite(`link ${installPath}${removed}`, () => linkForDevelopment(builtSkillPath, installPath));
    logger.info(`✓ Symlinked ${agentName} to ${installPath} (dev mode)`);
    logger.info(`  Rebuild agent to see changes immediately`);
  } else {
    // Staged beside the install and swapped in whole: a bundle the copy refuses
    // (a named pipe, a link out of it, a file or listing the OS will not read) or
    // a write that fails half-way never costs the previous install. The copy
    // codes every refusal of the bundle at its cause, so they pass through as
    // the input's; only a failure writing ~/.claude is the run not finishing.
    // The root takes the bundle's mode with the owner's rwx kept: a read-only
    // bundle must not become an install nothing can remove.
    const warnings = await codedUserStateWrite(`install ${builtSkillPath} to ${installPath}`, () =>
      replaceDirectoryWith(installPath, async (staged) => {
        await copyDirectory(builtSkillPath, staged);
        await fs.chmod(staged, ((await bundleRootMode(builtSkillPath)) & 0o7777) | OWNER_RWX);
      }),
    );
    for (const warning of warnings) logger.warn(warning);
    logger.info(`✓ Installed ${agentName} to ${installPath}`);
  }

  return { agent: agentName, installPath, symlink: dev };
}

/** The bundle root's mode — the input's to answer, so a refusal is INPUT_UNREADABLE. */
async function bundleRootMode(builtSkillPath: string): Promise<number> {
  try {
    return (await fs.stat(builtSkillPath)).mode;
  } catch (error) {
    throw new CommandRefusalError('INPUT_UNREADABLE', `Could not read the built bundle at ${builtSkillPath}: ${String(error)}`, { cause: error });
  }
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
        `Run: vat agent build ${agentName} --target ${runtimeDir}`
    );
  }
  return builtPath;
}

/**
 * Find the agent package root (directory containing package.json)
 */
function findAgentPackageRoot(manifestPath: string): Promise<string> {
  // Walk up until we find a package.json or hit the filesystem root
  const climb = async (currentDir: string): Promise<string> => {
    if (currentDir === path.dirname(currentDir)) {
      throw new CommandRefusalError(
        'USAGE_INVALID',
        `Could not find package.json for agent at ${manifestPath}. ` +
          `Agent must be within an npm package to install.`
      );
    }
    const packageJsonPath = safePath.join(currentDir, 'package.json');
    try {
      await fs.access(packageJsonPath);
      return currentDir;
    } catch (error) {
      // No manifest at this level: climb. A refused ancestor is not "no
      // manifest": the input's refusal.
      if (!isPathAbsentError(error)) throw unstatablePathRefusal(packageJsonPath, error);
    }
    return climb(path.dirname(currentDir));
  };
  return climb(path.dirname(safePath.resolve(manifestPath)));
}


/**
 * Install agent to Agent Skills directory
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadAgentManifest } from '@vibe-agent-toolkit/agent-config';
import { buildReport, toFindings, type Gate } from '@vibe-agent-toolkit/schema';
import { applyTreePlan, classifyFsFault, isPathAbsentError, pathPresent, planTreeChanges, safePath } from '@vibe-agent-toolkit/utils';

import { resolveAgentPath } from '../../utils/agent-discovery.js';
import { CommandRefusalError, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, leftoverIssue, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { occupiedRefusal, skillOwnership } from '../../utils/install-plan.js';
import { createLogger, type Logger } from '../../utils/logger.js';
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

/** `vat agent install` has no `--strict`, and its only findings are leftovers (warnings): the gate is fixed. */
const GATE: Gate = { strict: false };

/** What an install finished: the install, and what it left beside it that VAT could not remove. */
interface Installed {
  readonly data: AgentInstallData;
  readonly leftovers: ReadonlyArray<ReturnType<typeof leftoverIssue>>;
}

/**
 * Install agent command.
 *
 * The install is ONE tree-change plan: the copy, or the `--dev` link, is staged
 * beside the install and swapped in whole, so a refused run leaves any previous
 * install exactly as it was — every refusal publishes NOTHING_FINISHED, and
 * that is the truth. A previous install the swap parked and the OS would not
 * let VAT remove is a warning naming it, on a run that finished.
 */
export async function installAgent(
  agentName: string,
  options: InstallOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  let installed: Installed;
  try {
    installed = await install(agentName, options, logger);
  } catch (error) {
    return endWithRefusal('agent install', refusalCodeOf(error), error, 'yaml', GATE, NOTHING_FINISHED);
  }
  logger.debug(`Install completed in ${Date.now() - startTime}ms`);
  const { data, leftovers } = installed;
  endWithReport('agent install', buildReport({ examined: 1, findings: toFindings([...leftovers]), data, gate: GATE, durationMs: Date.now() - startTime }), 'yaml');
}

/** The install itself; every throw carries the refusal code of its cause. */
async function install(agentName: string, options: InstallOptions, logger: Logger): Promise<Installed> {
  const { runtime = 'agent-skill', scope = 'user', dev = false, force = false } = options;

  // `--dev` stages a symlink, and Windows gives one only with a privilege. Refused here, before
  // anything is examined, naming WSL and copy mode; should `--dev` ever work on Windows, a junction
  // (no privilege, as `dev-tools/src/link-workspace-packages.ts` makes) is the way. Never a silent
  // copy instead: `--dev` exists so a rebuild is picked up live.
  if (dev && process.platform === 'win32') {
    throw new CommandRefusalError(
      'NOT_IMPLEMENTED',
      '--dev (symlink) not supported on Windows.\n' +
        'Use copy mode (omit --dev) or WSL for development.'
    );
  }

  const targetLocation = validateAndGetScopeLocation(runtime, scope);

  // Refused by name before anything is examined — before the agent is even
  // looked up: with `--force` whatever is at this path is replaced, and the
  // positional is the one thing on it the user typed.
  const installPath = agentInstallPath(targetLocation, agentName);

  const builtSkillPath = await findBuiltSkill(agentName, runtime, logger);

  // Without `--force` the install path must be free (absent, or an empty directory): a previous
  // install, or a dangling `--dev` link `build:clean` orphaned, is refused before anything is
  // written. The plan makes ~/.claude/skills when absent and removes it again on a refusal. A copy
  // follows only links inside the bundle and gives each directory the bundle's mode with the
  // owner's rwx kept (the primitive's copy policy): a read-only bundle never becomes an install
  // nothing can remove.
  const plan = await planTreeChanges([{
    op: 'replace',
    dest: installPath,
    ownership: skillOwnership(force),
    fill: dev ? { from: 'link', target: builtSkillPath } : { from: 'copy', source: builtSkillPath, side: 'source', links: 'follow-contained' },
    label: `agent ${agentName}`,
  }]).catch((error: unknown) => {
    throw occupiedRefusal(error);
  });
  const { warnings } = await applyTreePlan(plan);

  if (dev) {
    logger.info(`✓ Symlinked ${agentName} to ${installPath} (dev mode)`);
    logger.info(`  Rebuild agent to see changes immediately`);
  } else {
    logger.info(`✓ Installed ${agentName} to ${installPath}`);
  }
  return {
    data: { agent: agentName, installPath, symlink: dev },
    leftovers: warnings.map(({ message, path }) => leftoverIssue(message, path)),
  };
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
  if (!pathPresent(builtPath, 'follow', 'source', 'probe')) {
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
      if (!isPathAbsentError(error)) throw classifyFsFault(error, { side: 'source', origin: 'content', action: 'look for the package around the agent', path: packageJsonPath });
    }
    return climb(path.dirname(currentDir));
  };
  return climb(path.dirname(safePath.resolve(manifestPath)));
}


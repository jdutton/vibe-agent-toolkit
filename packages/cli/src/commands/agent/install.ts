/**
 * Install agent to Agent Skills directory
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadAgentManifest } from '@vibe-agent-toolkit/agent-config';
import { copyDirectory, safePath } from '@vibe-agent-toolkit/utils';

import { resolveAgentPath } from '../../utils/agent-discovery.js';
import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { validateAndGetScopeLocation } from '../../utils/scope-locations.js';

export interface InstallOptions {
  scope?: 'user' | 'project';
  dev?: boolean;
  force?: boolean;
  runtime?: string;
  debug?: boolean;
}

/**
 * Install agent command
 */
export async function installAgent(
  agentName: string,
  options: InstallOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const { runtime = 'agent-skill', scope = 'user', dev = false, force = false } = options;

    // Windows check for dev mode
    if (dev && process.platform === 'win32') {
      throw new Error(
        '--dev (symlink) not supported on Windows.\n' +
          'Use copy mode (omit --dev) or WSL for development.'
      );
    }

    // Validate scope and get target location
    const targetLocation = validateAndGetScopeLocation(runtime, scope);

    // Find built skill
    const builtSkillPath = await findBuiltSkill(agentName, runtime, logger);
    const installPath = safePath.join(targetLocation, agentName);

    // Ensure target directory exists
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path constructed from validated scope location
    await fs.mkdir(targetLocation, { recursive: true });

    // Check if already installed.
    //
    // `lstat`, not `access`: `access` FOLLOWS symlinks, so a dangling dev-mode
    // link — precisely what `build:clean` orphans by deleting `dist/` under a
    // previous `--dev` install — answered ENOENT here. That fell into the catch
    // below as "not installed", which skipped the `--force` removal and left the
    // link in place for `fs.symlink` to reject with EEXIST. `--force` was inert
    // against the one state it most needed to clear. `lstat` stats the link
    // itself, so the entry is seen whether or not its target still exists.
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- installPath is built from a validated scope location
      await fs.lstat(installPath);
      if (!force) {
        logger.error(
          `\n${agentName} already installed at ${installPath}\n` +
            `Use --force to overwrite\n`
        );
        process.exit(1);
      }
      // Remove existing if force flag is set
      await fs.rm(installPath, { recursive: true, force: true });
    } catch {
      // Not installed, continue
    }

    if (dev) {
      await linkForDevelopment(builtSkillPath, installPath);
      logger.info(`✓ Symlinked ${agentName} to ${installPath} (dev mode)`);
      logger.info(`  Rebuild agent to see changes immediately`);
    } else {
      // Copy for production
      await copyDirectory(builtSkillPath, installPath);
      logger.info(`✓ Installed ${agentName} to ${installPath}`);
    }

    const duration = Date.now() - startTime;
    logger.debug(`Install completed in ${duration}ms`);

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Install');
  }
}

/**
 * Symlink a built bundle into place for `--dev`, failing legibly where the OS
 * refuses.
 *
 * A directory symlink on Windows requires `SeCreateSymbolicLinkPrivilege`
 * (Developer Mode, or an elevated shell), which most user machines and CI
 * agents do not hold. **`--dev` being unavailable there is an accepted
 * outcome** — it is a development convenience, and `install` without `--dev`
 * copies instead and needs no privilege. What is not acceptable is how this
 * used to fail: a bare `EPERM` reaching the generic handler, which reads as a
 * file-permission problem and names neither the missing privilege nor the way
 * out.
 *
 * Deliberately does NOT fall back to copying. `--dev` exists so a rebuild is
 * picked up live; a copy that reported success would leave someone editing
 * sources and wondering why nothing changes — a silent wrong answer in place of
 * a loud, correct refusal.
 *
 * @param builtSkillPath - Absolute path to the built bundle
 * @param installPath - Where the link should be created
 * @throws When the link cannot be created, naming the privilege and the remedy
 */
async function linkForDevelopment(builtSkillPath: string, installPath: string): Promise<void> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename, local/no-bare-symlink-in-tests -- eyes open: this is the guarded call the rule asks for. Windows without the privilege is an accepted unsupported case for --dev, and the catch below names it.
    await fs.symlink(builtSkillPath, installPath, 'dir');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not create the dev-mode symlink at ${installPath}: ${detail}\n` +
        (process.platform === 'win32'
          ? 'On Windows, creating a directory symlink requires SeCreateSymbolicLinkPrivilege. ' +
            'Enable Developer Mode or run from an elevated shell — or install without --dev, ' +
            'which copies the bundle instead and needs no privilege.'
          : `Re-run with --force to replace whatever is already at ${installPath}, ` +
            'or install without --dev to copy the bundle instead of linking it.'),
    );
  }
}

/**
 * Find built skill bundle
 */
async function findBuiltSkill(
  agentName: string,
  runtime: string,
  logger: ReturnType<typeof createLogger>
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

  try {
    await fs.access(builtPath);
    return builtPath;
  } catch {
    throw new Error(
      `Built skill not found at ${builtPath}\n` +
        `Run: vat agent build ${agentName} --runtime ${runtime}`
    );
  }
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
    } catch {
      currentDir = path.dirname(currentDir);
    }
  }

  throw new Error(
    `Could not find package.json for agent at ${manifestPath}. ` +
      `Agent must be within an npm package to install.`
  );
}


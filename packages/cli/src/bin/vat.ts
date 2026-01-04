#!/usr/bin/env node

/**
 * Smart wrapper for vat CLI
 * Detects context (dev/local/global) and spawns appropriate binary
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findProjectRoot } from '../utils/project-root.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

type Context = 'dev' | 'local' | 'global';

function spawnCli(binPath: string, context: Context, contextPath?: string): never {
  const env = {
    ...process.env,
    VAT_CONTEXT: context,
    VAT_CONTEXT_PATH: contextPath,
  };

  // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is always in PATH for CLI usage
  const result = spawnSync('node', [binPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });

  process.exit(result.status ?? 1);
}

/**
 * Check if we're in vibe-agent-toolkit repo (developer mode)
 * Simple detection: both wrapper and bin.js must exist in project structure
 *
 * @param projectRoot - Root directory of the project
 * @returns Path to bin.js if detected, null otherwise
 */
function getDevModeBinary(projectRoot: string): string | null {
  const wrapperPath = join(projectRoot, 'packages/cli/dist/bin/vat.js');
  const binPath = join(projectRoot, 'packages/cli/dist/bin.js');

  // Both files must exist to confirm we're in vibe-agent-toolkit repo
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checking project structure files
  if (existsSync(wrapperPath) && existsSync(binPath)) {
    return binPath;
  }

  return null;
}

// 1. Explicit override via VAT_ROOT_DIR
if (process.env['VAT_ROOT_DIR']) {
  const binPath = join(process.env['VAT_ROOT_DIR'], 'packages/cli/dist/bin.js');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dynamic path from env is expected
  if (existsSync(binPath)) {
    spawnCli(binPath, 'dev', process.env['VAT_ROOT_DIR']);
  }
}

// Get project root from current working directory
const projectRoot = findProjectRoot(process.cwd());

// 2. Dev mode detection (running inside vibe-agent-toolkit repo from any location)
if (projectRoot) {
  const devBinPath = getDevModeBinary(projectRoot);
  if (devBinPath) {
    spawnCli(devBinPath, 'dev', projectRoot);
  }
}

// 3. Local project install
if (projectRoot) {
  const localBinPath = join(
    projectRoot,
    'node_modules/@vibe-agent-toolkit/cli/dist/bin.js'
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dynamic path from project root is expected
  if (existsSync(localBinPath)) {
    spawnCli(localBinPath, 'local', projectRoot);
  }
}

// 4. Global install fallback
const globalBinPath = resolve(__dirname, '../bin.js');
spawnCli(globalBinPath, 'global');

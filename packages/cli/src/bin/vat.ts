#!/usr/bin/env node

/**
 * Smart vat wrapper with context-aware execution
 *
 * Automatically detects execution context and delegates to appropriate binary:
 * - Developer mode: Inside vibe-agent-toolkit repo → packages/cli/dist/bin.js (unpackaged dev build)
 * - Local install: Project has vibe-agent-toolkit → node_modules version (packaged)
 * - Global install: Fallback → globally installed version (packaged)
 *
 * Features:
 * - Version detection and comparison
 * - Debug mode (VAT_DEBUG=1) shows resolution details
 * - Works from any subdirectory within the repo
 *
 * Works in both git and non-git directories.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

  if (process.env['VAT_DEBUG'] === '1') {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checking project structure files for debug
    console.error(`[vat debug] Dev check - wrapper: ${wrapperPath} (${existsSync(wrapperPath)})`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checking project structure files for debug
    console.error(`[vat debug] Dev check - bin: ${binPath} (${existsSync(binPath)})`);
  }

  // Both files must exist to confirm we're in vibe-agent-toolkit repo
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checking project structure files
  if (existsSync(wrapperPath) && existsSync(binPath)) {
    return binPath;
  }

  return null;
}

/**
 * Find local vibe-agent-toolkit installation in node_modules
 * Walks up directory tree from project root
 *
 * @param projectRoot - Root directory to start searching from
 * @returns Path to local bin.js if found, null otherwise
 */
function findLocalInstall(projectRoot: string): string | null {
  let current = projectRoot;
  while (true) {
    const localBin = join(current, 'node_modules/@vibe-agent-toolkit/cli/dist/bin.js');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checking for local install
    if (existsSync(localBin)) {
      return localBin;
    }
    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root
      break;
    }
    current = parent;
  }
  return null;
}

/**
 * Read version from package.json
 * @param packageJsonPath - Path to package.json file
 * @returns Version string or null if not found
 */
function readVersion(packageJsonPath: string): string | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reading version from package.json
    if (!existsSync(packageJsonPath)) {
      return null;
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reading version from package.json
    const content = readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Main entry point - detects context and executes appropriate binary
 */
function main(): void {
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  const debug = process.env['VAT_DEBUG'] === '1';

  // Priority 1: Explicit override via VAT_ROOT_DIR
  if (process.env['VAT_ROOT_DIR']) {
    const binPath = join(process.env['VAT_ROOT_DIR'], 'packages/cli/dist/bin.js');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dynamic path from env is expected
    if (existsSync(binPath)) {
      if (debug) {
        console.error('[vat debug] Using VAT_ROOT_DIR override');
        console.error(`[vat debug] Binary: ${binPath}`);
      }
      spawnCli(binPath, 'dev', process.env['VAT_ROOT_DIR']);
    }
  }

  // Find project root from current working directory
  const projectRoot = findProjectRoot(cwd) ?? cwd;

  let binPath: string;
  let context: Context;
  let binDir: string;

  // Priority 2: Check for developer mode (inside vibe-agent-toolkit repo)
  const devBin = getDevModeBinary(projectRoot);
  if (devBin) {
    binPath = devBin;
    context = 'dev';
    binDir = dirname(dirname(devBin)); // packages/cli/dist -> packages/cli
  }
  // Priority 3: Check for local install (node_modules)
  else {
    const localBin = findLocalInstall(projectRoot);
    if (localBin) {
      binPath = localBin;
      context = 'local';
      binDir = dirname(dirname(localBin)); // node_modules/@vibe-agent-toolkit/cli/dist -> node_modules/@vibe-agent-toolkit/cli
    }
    // Priority 4: Use global install (this script's location)
    else {
      binPath = resolve(__dirname, '../bin.js');
      context = 'global';
      binDir = dirname(__dirname); // dist -> cli root
    }
  }

  // Read versions for comparison
  // __dirname = dist/bin, so go up twice to reach package.json at cli root
  const globalPkgPath = join(dirname(dirname(__dirname)), 'package.json');
  const globalVersion = readVersion(globalPkgPath);
  let localVersion: string | null = null;
  if (context === 'local') {
    const localPkgPath = join(binDir, 'package.json');
    localVersion = readVersion(localPkgPath);
  }

  // Debug output
  if (debug) {
    console.error(`[vat debug] CWD: ${cwd}`);
    console.error(`[vat debug] Project root: ${projectRoot}`);
    console.error(`[vat debug] Context: ${context}`);
    console.error(`[vat debug] Binary: ${binPath}`);
    console.error(`[vat debug] Global version: ${globalVersion ?? 'unknown'}`);
    console.error(`[vat debug] Local version: ${localVersion ?? 'N/A'}`);
    console.error(`[vat debug] Args: ${args.join(' ')}`);
  }

  // Execute the binary with all arguments (only pass projectRoot for dev context)
  const contextPath = context === 'dev' ? projectRoot : undefined;
  spawnCli(binPath, context, contextPath);
}

// Run main function
main();

#!/usr/bin/env tsx
/* eslint-disable security/detect-non-literal-fs-filename */
// File paths derived from packageDir parameter (controlled directory scanning)
/**
 * Fix Workspace Dependencies Script
 *
 * Replaces exact version references to internal packages with workspace:*
 * This ensures bun install uses local workspace packages instead of trying
 * to fetch from npm during CI builds.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from './common.js';

const PROJECT_ROOT = process.cwd();
const PACKAGES_DIR = join(PROJECT_ROOT, 'packages');
const SCOPE = '@vibe-agent-toolkit';
const WORKSPACE_PROTOCOL = 'workspace:*';

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function fixDependencies(deps: Record<string, string> | undefined): number {
  if (!deps) return 0;

  let fixed = 0;
  for (const [dep, version] of Object.entries(deps)) {
    if (dep.startsWith(SCOPE) && version !== WORKSPACE_PROTOCOL) {
      deps[dep] = WORKSPACE_PROTOCOL;
      fixed++;
    }
  }
  return fixed;
}

function processPackage(packageDir: string): number {
  const packageJsonPath = join(PACKAGES_DIR, packageDir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;

  const fixedDeps = fixDependencies(packageJson.dependencies);
  const fixedDevDeps = fixDependencies(packageJson.devDependencies);
  const fixed = fixedDeps + fixedDevDeps;

  if (fixed > 0) {
    writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
    log(`  ✓ ${packageJson.name}: Fixed ${fixed} dependencies`, 'green');
  }

  return fixed;
}

function main(): void {
  log('\n🔧 Fixing workspace dependencies...', 'blue');
  log('─'.repeat(60), 'blue');

  const packageDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  const totalFixed = packageDirs.reduce((total, packageDir) => total + processPackage(packageDir), 0);

  log('─'.repeat(60), 'blue');
  if (totalFixed > 0) {
    log(`\n✅ Fixed ${totalFixed} workspace dependencies`, 'green');
    log('\n💡 Run "bun install" to update lockfile', 'yellow');
  } else {
    log('\n✅ All workspace dependencies already correct', 'green');
  }
}

main();

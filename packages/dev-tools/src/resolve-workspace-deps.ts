#!/usr/bin/env tsx
/* eslint-disable security/detect-non-literal-fs-filename */
// File paths derived from PACKAGES_DIR constant (controlled directory scanning)

/**
 * resolve-workspace-deps.ts
 *
 * Resolves workspace:* dependencies to actual versions before publishing to npm.
 *
 * Why: npm publish doesn't understand Bun's workspace:* protocol. Only bun publish
 * handles this automatically, but bun doesn't support --provenance flag needed for
 * supply chain security.
 *
 * Solution: This script replaces workspace:* with actual versions from the packages
 * being published. It modifies package.json files in-place, so it should only be
 * run in CI or in a temp directory, never on git-tracked files during development.
 *
 * Usage:
 *   bun run resolve-workspace-deps <version>
 *
 * Example:
 *   bun run resolve-workspace-deps 0.1.0-rc.7
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from './common.js';

const PACKAGES_DIR = join(import.meta.dirname, '../../../packages');
const SCOPE = '@vibe-agent-toolkit';

interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function resolveDependencies(deps: Record<string, string> | undefined, version: string): number {
  if (!deps) return 0;

  let resolved = 0;
  for (const [dep, currentVersion] of Object.entries(deps)) {
    if (dep.startsWith(SCOPE) && currentVersion === 'workspace:*') {
      deps[dep] = version;
      resolved++;
    }
  }
  return resolved;
}

function processPackage(packageDir: string, version: string): number {
  const packageJsonPath = join(PACKAGES_DIR, packageDir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;

  const resolvedDeps = resolveDependencies(packageJson.dependencies, version);
  const resolvedDevDeps = resolveDependencies(packageJson.devDependencies, version);
  const resolvedPeerDeps = resolveDependencies(packageJson.peerDependencies, version);
  const resolved = resolvedDeps + resolvedDevDeps + resolvedPeerDeps;

  if (resolved > 0) {
    writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
    log(`  ✓ ${packageJson.name}: Resolved ${resolved} workspace dependencies to ${version}`, 'green');
  }

  return resolved;
}

function getAllPackageDirs(): string[] {
  return readdirSync(PACKAGES_DIR).filter((dir) => {
    const fullPath = join(PACKAGES_DIR, dir);
    const isDirectory = statSync(fullPath).isDirectory();
    if (!isDirectory) return false;
    const hasPackageJson = readdirSync(fullPath).includes('package.json');
    return hasPackageJson;
  });
}

function main(): void {
  const version = process.argv[2];

  if (!version) {
    log('❌ Error: Version argument required', 'red');
    console.log('Usage: bun run resolve-workspace-deps <version>');
    console.log('Example: bun run resolve-workspace-deps 0.1.0-rc.7');
    process.exit(1);
  }

  log(`\n🔧 Resolving workspace:* dependencies to ${version}...`, 'blue');

  const packageDirs = getAllPackageDirs();
  let totalResolved = 0;

  for (const packageDir of packageDirs) {
    totalResolved += processPackage(packageDir, version);
  }

  log(`\n✅ Resolved ${totalResolved} total workspace dependencies to ${version}`, 'green');
}

main();

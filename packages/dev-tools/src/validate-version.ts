#!/usr/bin/env tsx
/* eslint-disable security/detect-non-literal-fs-filename */
// File paths derived from projectRoot parameter (controlled, not user input)

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { log } from './common.js';

interface PackageInfo {
  name: string;
  version: string;
  path: string;
}

function readPackageVersion(packagePath: string): PackageInfo | null {
  const packageJsonPath = join(packagePath, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const content = readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content) as { name?: string; version?: string };
    if (!pkg.name || !pkg.version) {
      return null;
    }
    return {
      name: pkg.name,
      version: pkg.version,
      path: packagePath,
    };
  } catch {
    return null;
  }
}

function validateVersion(projectRoot: string): void {
  const packagesDir = join(projectRoot, 'packages');

  if (!existsSync(packagesDir)) {
    log('✗ No packages directory found', 'red');
    process.exit(1);
  }

  const packages: PackageInfo[] = [];
  const dirs = readdirSync(packagesDir);

  for (const dir of dirs) {
    const packagePath = join(packagesDir, dir);
    const info = readPackageVersion(packagePath);
    if (info && !info.name.includes('dev-tools')) {
      packages.push(info);
    }
  }

  if (packages.length === 0) {
    log('✗ No publishable packages found', 'red');
    process.exit(1);
  }

  const versions = new Set(packages.map(p => p.version));

  if (versions.size > 1) {
    log('✗ Version mismatch detected:', 'red');
    for (const pkg of packages) {
      log(`  ${pkg.name}: ${pkg.version}`, 'red');
    }
    process.exit(1);
  }

  // We know packages has at least one element due to earlier check
  const firstPackage = packages[0];
  if (!firstPackage) {
    log('✗ Unexpected error: no packages found', 'red');
    process.exit(1);
  }

  const version = firstPackage.version;
  log(`✓ All ${packages.length} packages have version ${version}`, 'green');
}

const projectRoot = process.argv[2] ?? process.cwd();
validateVersion(projectRoot);

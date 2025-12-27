/**
 * Version Bump Script
 *
 * Updates version in ALL package.json files (root + all workspace packages).
 * This ensures consistent versioning across the monorepo.
 *
 * Usage:
 *   tsx tools/bump-version.ts <version|increment>
 *   bun run bump-version <version|increment>
 *
 * Examples:
 *   tsx tools/bump-version.ts 1.0.0        # Set to explicit version
 *   tsx tools/bump-version.ts patch        # Increment patch (1.0.0 -> 1.0.1)
 *   tsx tools/bump-version.ts minor        # Increment minor (1.0.0 -> 1.1.0)
 *   tsx tools/bump-version.ts major        # Increment major (1.0.0 -> 2.0.0)
 *
 * Exit codes:
 *   0 - Success
 *   1 - Error (invalid version, file not found, etc.)
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// File paths derived from PROJECT_ROOT (controlled, not user input)

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import semver from 'semver';

import { PROJECT_ROOT, log, processWorkspacePackages, type PackageProcessResult } from './common.js';

const PACKAGE_JSON = 'package.json';

// Parse command-line arguments
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
Version Bump Script

Updates version in ALL package.json files (root + all workspace packages).

Usage:
  tsx tools/bump-version.ts <version|increment>
  bun run bump-version <version|increment>

Arguments:
  version      Explicit version (e.g., 1.0.0, 2.0.0)
  increment    patch, minor, or major (auto-calculates from current version)

Examples:
  tsx tools/bump-version.ts 1.0.0      # Set to explicit version
  tsx tools/bump-version.ts patch      # Increment patch (1.0.0 -> 1.0.1)
  tsx tools/bump-version.ts minor      # Increment minor (1.0.0 -> 1.1.0)
  tsx tools/bump-version.ts major      # Increment major (1.0.0 -> 2.0.0)

Exit codes:
  0 - Success
  1 - Error (invalid version, file not found, etc.)
  `);
  process.exit(args.length === 0 ? 1 : 0);
}

// After help check, we know args.length > 0
const versionArg = args[0];
if (!versionArg) {
  log('✗ Version argument is required', 'red');
  process.exit(1);
}

// Helper to increment version
function incrementVersion(currentVersion: string, type: string): string {
  const parts = currentVersion.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid current version: ${currentVersion}`);
  }

  // Safe to cast after validation: we've confirmed exactly 3 valid numbers
  let [major, minor, patch] = parts as [number, number, number];

  switch (type) {
    case 'patch': {
      patch++;
      break;
    }
    case 'minor': {
      minor++;
      patch = 0;
      break;
    }
    case 'major': {
      major++;
      minor = 0;
      patch = 0;
      break;
    }
    default: {
      throw new Error(`Invalid increment type: ${type}`);
    }
  }

  return `${major}.${minor}.${patch}`;
}

// Determine new version
let newVersion: string;
if (['patch', 'minor', 'major'].includes(versionArg)) {
  // Get current version from root package.json
  try {
    const rootPkgPath = join(PROJECT_ROOT, PACKAGE_JSON);
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
    const currentVersion = rootPkg.version;

    if (!currentVersion) {
      log('✗ Could not determine current version from root package.json', 'red');
      process.exit(1);
    }

    newVersion = incrementVersion(currentVersion, versionArg);
    log(`Current version: ${currentVersion}`, 'blue');
    log(`Increment type: ${versionArg}`, 'blue');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`✗ Failed to read current version: ${message}`, 'red');
    process.exit(1);
  }
} else {
  // Explicit version provided
  newVersion = versionArg;

  // Validate version format using semver
  if (!semver.valid(newVersion)) {
    log(`✗ Invalid version format: ${newVersion}`, 'red');
    log('  Expected format: X.Y.Z or X.Y.Z-prerelease', 'yellow');
    log('  Examples: 1.0.0, 2.0.0, 1.0.0-beta.1, patch, minor, major', 'yellow');
    process.exit(1);
  }
}

log(`📦 Bumping version to ${newVersion}`, 'blue');
console.log('');

interface VersionUpdateResult extends PackageProcessResult {
  updated?: boolean;
  oldVersion?: string;
  newVersion?: string;
}

// Function to update version in a package.json file
function updatePackageVersion(filePath: string, newVersion: string): VersionUpdateResult {
  try {
    const content = readFileSync(filePath, 'utf8');
    const pkg = JSON.parse(content);
    const oldVersion = pkg.version;

    // Skip packages without version field
    if (!oldVersion) {
      return { skipped: true, reason: 'no-version', name: pkg.name };
    }

    if (oldVersion === newVersion) {
      return { skipped: false, updated: false, oldVersion, newVersion, name: pkg.name };
    }

    pkg.version = newVersion;

    // Preserve original formatting by replacing only the version line
    const updatedContent = content.replace(
      /"version":\s*"[^"]+"/,
      `"version": "${newVersion}"`
    );

    writeFileSync(filePath, updatedContent, 'utf8');

    return { skipped: false, updated: true, oldVersion, newVersion, name: pkg.name };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to update ${filePath}: ${message}`);
  }
}

// Update root package.json
const rootPackagePath = join(PROJECT_ROOT, PACKAGE_JSON);
log('Updating root package.json...', 'blue');

try {
  const result = updatePackageVersion(rootPackagePath, newVersion);
  if (result.skipped) {
    log(`  - ${result.name || 'root'}: skipped (${result.reason})`, 'yellow');
  } else if (result.updated) {
    log(`  ✓ ${result.name || 'root'}: ${result.oldVersion} → ${result.newVersion}`, 'green');
  } else {
    log(`  - ${result.name || 'root'}: already at ${result.newVersion}`, 'yellow');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`  ✗ ${message}`, 'red');
  process.exit(1);
}

console.log('');
log('Updating workspace packages...', 'blue');

// Check if packages directory exists
const packagesDir = join(PROJECT_ROOT, 'packages');
let hasPackages = false;
try {
  const packages = readdirSync(packagesDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory());
  hasPackages = packages.length > 0;
} catch {
  hasPackages = false;
}

if (hasPackages) {
  // Update all workspace packages
  const counts = processWorkspacePackages<VersionUpdateResult>(
    (pkgPath) => updatePackageVersion(pkgPath, newVersion),
    (result) => {
      if (result.updated) {
        log(`  ✓ ${result.name}: ${result.oldVersion} → ${result.newVersion}`, 'green');
      } else {
        log(`  - ${result.name}: already at ${result.newVersion}`, 'yellow');
      }
    },
    () => {
      // Skip logging handled by processWorkspacePackages
    }
  );

  const updatedCount = counts.processed;
  const skippedCount = counts.skipped;

  if (updatedCount === 0 && skippedCount === 0) {
    log('  - No packages found', 'yellow');
  }
} else {
  log('  - No packages found', 'yellow');
}

console.log('');
log(`✅ Version bump complete!`, 'green');
console.log('');
console.log('Next steps:');
console.log(`  1. Review changes: git diff`);
console.log(`  2. Commit: git add -A && git commit -m "chore: Release v${newVersion}"`);
console.log(`  3. Tag: git tag v${newVersion}`);
console.log(`  4. Push: git push origin main && git push origin v${newVersion}`);
console.log('');

process.exit(0);

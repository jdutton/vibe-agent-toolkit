/**
 * Publish Tag Determination Script
 *
 * Determines npm dist-tags and version type based on version string.
 * For stable versions, checks if @next tag should be updated via semver comparison.
 *
 * Usage:
 *   tsx tools/determine-publish-tags.ts <version>
 *
 * Examples:
 *   tsx tools/determine-publish-tags.ts 1.0.0-rc.1
 *   tsx tools/determine-publish-tags.ts 1.0.0
 *
 * Outputs (GitHub Actions format):
 *   is_stable=true|false
 *   is_rc=true|false
 *   primary_tag=latest|next
 *   update_next=true|false (only for stable versions)
 *
 * Exit codes:
 *   0 - Success
 *   1 - Error (invalid version, network error, etc.)
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// appendFileSync uses GITHUB_OUTPUT env var (controlled by GitHub Actions)
// readFileSync reads from PROJECT_ROOT constant (controlled, not user input)

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import semver from 'semver';

import { log, getNpmTagVersion, PROJECT_ROOT } from './common.js';

/**
 * Output GitHub Actions output variable
 */
function setGitHubOutput(name: string, value: string): void {
  const githubOutput = process.env['GITHUB_OUTPUT'];
  if (githubOutput) {
    // Running in GitHub Actions - append to $GITHUB_OUTPUT file
    appendFileSync(githubOutput, `${name}=${value}\n`);
  } else {
    // Running locally - output to console for debugging
    console.log(`[OUTPUT] ${name}=${value}`);
  }
}

// Parse command-line arguments
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
Publish Tag Determination Script

Determines npm dist-tags and version type based on version string.

Usage:
  tsx tools/determine-publish-tags.ts <version>

Examples:
  tsx tools/determine-publish-tags.ts 1.0.0-rc.1  # RC version
  tsx tools/determine-publish-tags.ts 1.0.0       # Stable version

Outputs (GitHub Actions format):
  is_stable=true|false        # Is this a stable release?
  is_rc=true|false            # Is this an RC release?
  primary_tag=latest|next     # Primary npm dist-tag to use
  update_next=true|false      # Should @next tag be updated? (stable only)

Exit codes:
  0 - Success
  1 - Error (invalid version, network error, etc.)
  `);
  process.exit(args.length === 0 ? 1 : 0);
}

const version = args[0];

// Validate version format (semver)
if (!version || !semver.valid(version)) {
  log(`✗ Invalid semver version: ${String(version ?? '(missing)')}`, 'red');
  log('  Expected format: X.Y.Z or X.Y.Z-prerelease', 'yellow');
  log('  Examples: 1.0.0, 2.0.0, 1.0.0-rc.1', 'yellow');
  process.exit(1);
}

// TypeScript now knows version is a valid string
log(`🏷️  Determining publish tags for: ${version}`, 'blue');
console.log('');

// Determine version type
const isPrerelease = semver.prerelease(version) !== null;
const isStable = !isPrerelease;
const isRC = isPrerelease && version.includes('-rc');

// Determine primary npm dist-tag
const primaryTag = isStable ? 'latest' : 'next';

// Determine version type label
let versionType = 'Prerelease';
if (isStable) {
  versionType = 'Stable';
} else if (isRC) {
  versionType = 'RC (Release Candidate)';
}

log(`Version type: ${versionType}`, isStable ? 'green' : 'yellow');
log(`Primary npm tag: @${primaryTag}`, 'blue');

// For stable versions, check if we should update @next tag
let updateNext = false;
if (isStable) {
  log('', 'reset');
  log('Checking if @next tag should be updated...', 'blue');

  // Read package name from root package.json
  let packageName: string | undefined;
  try {
    const rootPkgPath = join(PROJECT_ROOT, 'package.json');
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
    packageName = rootPkg.name;

    if (!packageName) {
      throw new Error('Package name not found in root package.json');
    }

    log(`  Package: ${packageName}`, 'blue');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`  ✗ Failed to read package name: ${message}`, 'red');
    log('  → Defaulting to update @next (safer)', 'yellow');
    updateNext = true;
  }

  if (packageName) {
    try {
      const currentNextVersion = getNpmTagVersion(packageName, 'next');

      if (currentNextVersion) {
        log(`  Current @next version: ${currentNextVersion}`, 'blue');

        // Compare versions using semver
        if (semver.gt(version, currentNextVersion)) {
          log(`  ✓ ${version} > ${currentNextVersion}`, 'green');
          log('  → Will update @next to this stable version', 'green');
          updateNext = true;
        } else {
          log(`  - ${version} <= ${currentNextVersion}`, 'yellow');
          log('  → Will NOT update @next (already newer or equal)', 'yellow');
        }
      } else {
        log('  ⚠ No current @next version found on npm', 'yellow');
        log('  → Will update @next to this stable version', 'green');
        updateNext = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`  ✗ Failed to query npm registry: ${message}`, 'red');
      log('  → Defaulting to update @next (safer)', 'yellow');
      updateNext = true;
    }
  }
}

console.log('');
log('📋 Summary:', 'blue');
log(`  Version: ${version}`, 'reset');
log(`  Type: ${versionType}`, 'reset');
log(`  Primary tag: @${primaryTag}`, 'reset');
if (isStable) {
  log(`  Update @next: ${updateNext ? 'Yes' : 'No'}`, updateNext ? 'green' : 'yellow');
}

console.log('');

// Output GitHub Actions outputs
setGitHubOutput('is_stable', isStable ? 'true' : 'false');
setGitHubOutput('is_rc', isRC ? 'true' : 'false');
setGitHubOutput('primary_tag', primaryTag);
setGitHubOutput('update_next', updateNext ? 'true' : 'false');

log('✅ Tag determination complete', 'green');
console.log('');

process.exit(0);

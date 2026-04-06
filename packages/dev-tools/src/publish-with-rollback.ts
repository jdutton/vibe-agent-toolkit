#!/usr/bin/env tsx
/**
 * Publish with Rollback Safety Script
 *
 * Publishes all packages in dependency order with rollback capability.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import semver from 'semver';

import { log, safeExecResult, safeExecSync } from './common.js';
import { PUBLISHED_PACKAGES } from './package-lists.js';
import { validatePackageList as validatePackages } from './validate-package-list.js';

const PROJECT_ROOT = process.cwd();
const MANIFEST_PATH = safePath.join(PROJECT_ROOT, '.publish-manifest.json');
const VIBE_AGENT_TOOLKIT_SCOPE = '@vibe-agent-toolkit/';
const PACKAGES_DIR = 'packages';
const UMBRELLA_PACKAGE_NAME = 'vibe-agent-toolkit';

// Use published packages list as PACKAGES for compatibility with existing code
const PACKAGES: readonly string[] = PUBLISHED_PACKAGES;

/**
 * Validate that all packages are accounted for in either PACKAGES or SKIP_PACKAGES
 */
function validatePackageList(): void {
  try {
    const validation = validatePackages(PROJECT_ROOT);
    const hasErrors = validation.undeclared.length > 0 || validation.phantom.length > 0;

    if (hasErrors) {
      log('✗ Package list out of sync!', 'red');

      if (validation.undeclared.length > 0) {
        log('  The following packages exist in packages/ but are not declared:', 'red');
        for (const pkg of validation.undeclared) {
          log(`    - ${pkg}`, 'red');
        }
      }

      if (validation.phantom.length > 0) {
        log('  The following packages are declared but do not exist:', 'red');
        for (const pkg of validation.phantom) {
          log(`    - ${pkg}`, 'red');
        }
      }

      log('\n  Update packages/dev-tools/src/package-lists.ts:', 'yellow');
      log('    - Add undeclared packages to PUBLISHED_PACKAGES or SKIP_PACKAGES', 'yellow');
      log('    - Remove phantom packages from the lists', 'yellow');
      process.exit(1);
    }

    log('✓ All packages accounted for in publish script', 'green');
  } catch (error) {
    log('✗ Failed to validate package list', 'red');
    const message = error instanceof Error ? error.message : String(error);
    log(message, 'red');
    process.exit(1);
  }
}

interface Manifest {
  version: string;
  primaryTag: string;
  publishedPackages: string[];
  nextTagAdded: boolean;
}

const manifest: Manifest = {
  version: '',
  primaryTag: '',
  publishedPackages: [],
  nextTagAdded: false,
};

function saveManifest(): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- MANIFEST_PATH is a constant path
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

function loadManifest(): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- MANIFEST_PATH is a constant path
  if (existsSync(MANIFEST_PATH)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- MANIFEST_PATH is a constant path
    const content = readFileSync(MANIFEST_PATH, 'utf8');
    Object.assign(manifest, JSON.parse(content));
  }
}

function cleanupManifest(): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- MANIFEST_PATH is a constant path
  if (existsSync(MANIFEST_PATH)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- MANIFEST_PATH is a constant path
    unlinkSync(MANIFEST_PATH);
  }
}

function publishPackage(packageName: string, version: string, tag: string, dryRun: boolean): { success: boolean; dryRun?: boolean; error?: unknown } {
  const packagePath = safePath.join(PROJECT_ROOT, PACKAGES_DIR, packageName);
  const fullPackageName = packageName === UMBRELLA_PACKAGE_NAME
    ? UMBRELLA_PACKAGE_NAME
    : `${VIBE_AGENT_TOOLKIT_SCOPE}${packageName}`;

  log(`\n📦 Publishing ${fullPackageName}@${version} with tag @${tag}...`, 'blue');

  if (dryRun) {
    log('  [DRY-RUN] Skipping actual publish', 'yellow');
    return { success: true, dryRun: true };
  }

  try {
    const args = ['publish', '--access', 'public', '--tag', tag];

    if (process.env['CI'] && process.env['GITHUB_ACTIONS']) {
      args.push('--provenance');
    }

    safeExecSync('npm', args, {
      cwd: packagePath,
      stdio: 'inherit',
    });

    log(`  ✅ ${fullPackageName} published successfully`, 'green');
    return { success: true };
  } catch (error) {
    log(`  ❌ Failed to publish ${fullPackageName}`, 'red');
    return { success: false, error };
  }
}

function unpublishPackage(packageName: string, version: string, dryRun: boolean): { success: boolean; dryRun?: boolean; reason?: string } {
  const fullPackageName = packageName === UMBRELLA_PACKAGE_NAME
    ? UMBRELLA_PACKAGE_NAME
    : `${VIBE_AGENT_TOOLKIT_SCOPE}${packageName}`;

  log(`  Unpublishing ${fullPackageName}@${version}...`, 'yellow');

  if (dryRun) {
    log('    [DRY-RUN] Skipping actual unpublish', 'yellow');
    return { success: true, dryRun: true };
  }

  const result = safeExecResult('npm', ['unpublish', `${fullPackageName}@${version}`, '--force'], {
    stdio: 'pipe',
  });

  if (result.status === 0) {
    log('    ✅ Unpublished successfully', 'green');
    return { success: true };
  }

  log('    ⚠️  Unpublish failed (likely >72hr limit)', 'yellow');
  return { success: false, reason: 'unpublish_failed' };
}

function deprecatePackage(packageName: string, version: string, dryRun: boolean): { success: boolean; dryRun?: boolean } {
  const fullPackageName = packageName === UMBRELLA_PACKAGE_NAME
    ? UMBRELLA_PACKAGE_NAME
    : `${VIBE_AGENT_TOOLKIT_SCOPE}${packageName}`;
  const message = '⚠️ Incomplete publish - DO NOT USE. See https://github.com/jdutton/vibe-agent-toolkit/issues';

  log(`  Deprecating ${fullPackageName}@${version}...`, 'yellow');

  if (dryRun) {
    log('    [DRY-RUN] Skipping actual deprecation', 'yellow');
    return { success: true, dryRun: true };
  }

  const result = safeExecResult('npm', ['deprecate', `${fullPackageName}@${version}`, message], {
    stdio: 'pipe',
  });

  if (result.status === 0) {
    log('    ✅ Deprecated with warning', 'green');
    return { success: true };
  }

  log('    ❌ Deprecation failed', 'red');
  return { success: false };
}

function addDistTag(packageName: string, version: string, tag: string, dryRun: boolean): { success: boolean; dryRun?: boolean } {
  const fullPackageName = packageName === UMBRELLA_PACKAGE_NAME
    ? UMBRELLA_PACKAGE_NAME
    : `${VIBE_AGENT_TOOLKIT_SCOPE}${packageName}`;

  log(`  Adding @${tag} tag to ${fullPackageName}@${version}...`, 'blue');

  if (dryRun) {
    log('    [DRY-RUN] Skipping actual tag addition', 'yellow');
    return { success: true, dryRun: true };
  }

  const result = safeExecResult('npm', ['dist-tag', 'add', `${fullPackageName}@${version}`, tag], {
    stdio: 'pipe',
  });

  if (result.success) {
    log(`    ✅ @${tag} tag added`, 'green');
    return { success: true };
  }

  log(`    ❌ Failed to add @${tag} tag`, 'red');
  return { success: false };
}

function rollback(dryRun: boolean): void {
  log('\n🔄 ROLLBACK: Attempting to unpublish packages...', 'yellow');
  log('─'.repeat(60), 'yellow');

  loadManifest();

  if (manifest.publishedPackages.length === 0) {
    log('  No packages to rollback', 'yellow');
    return;
  }

  const packagesToRollback = [...manifest.publishedPackages].reverse();

  for (const packageName of packagesToRollback) {
    const unpublishResult = unpublishPackage(packageName, manifest.version, dryRun);

    if (!unpublishResult.success) {
      deprecatePackage(packageName, manifest.version, dryRun);
    }
  }

  cleanupManifest();
}

/**
 * Phase 2: Update @next tag for stable releases if needed
 */
function updateNextTag(version: string, dryRun: boolean): void {
  log('\n📋 Phase 2: Updating @next tag...', 'blue');
  log('─'.repeat(60), 'blue');

  for (const pkg of PACKAGES) {
    const result = addDistTag(pkg, version, 'next', dryRun);

    if (!result.success) {
      log('\n❌ Failed to add @next tag!', 'red');
      log(`   Package: ${pkg}`, 'red');
      log('   All packages published but @next tag incomplete', 'red');
      rollback(dryRun);
      process.exit(1);
    }
  }

  manifest.nextTagAdded = true;
  saveManifest();
  log('\n  ✅ @next tag added to all packages', 'green');
  log('\n✅ Phase 2 complete', 'green');
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(`
Usage: publish-with-rollback.ts <version> [--dry-run]

Examples:
  publish-with-rollback.ts 0.1.0-rc.1
  publish-with-rollback.ts 0.1.0
  publish-with-rollback.ts 0.1.0 --dry-run
    `);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const version = args[0];
  const dryRun = args.includes('--dry-run');

  if (!version) {
    log('✗ Version is required', 'red');
    process.exit(1);
  }

  if (!semver.valid(version)) {
    log(`✗ Invalid semver version: ${version}`, 'red');
    process.exit(1);
  }

  // Validate package list is in sync
  validatePackageList();

  const isStable = semver.prerelease(version) === null;
  const primaryTag = isStable ? 'latest' : 'next';
  const updateNext = isStable && process.env['UPDATE_NEXT'] === 'true';

  manifest.version = version;
  manifest.primaryTag = primaryTag;
  saveManifest();

  log('\n' + '='.repeat(60), 'blue');
  log(`📦 Publishing vibe-agent-toolkit v${version}`, 'blue');
  log(`🏷️  Primary npm tag: @${primaryTag}`, 'blue');
  if (updateNext) {
    log('🏷️  Will also update @next tag', 'blue');
  }
  if (dryRun) {
    log('🧪 DRY-RUN MODE', 'yellow');
  }
  log('='.repeat(60) + '\n', 'blue');

  // Phase 1: Publish all packages with primary tag
  log('📋 Phase 1: Publishing packages...', 'blue');
  log('─'.repeat(60), 'blue');

  for (const pkg of PACKAGES) {
    const result = publishPackage(pkg, version, primaryTag, dryRun);

    if (result.success) {
      manifest.publishedPackages.push(pkg);
      saveManifest();
    } else {
      log('\n❌ Publish failed!', 'red');
      rollback(dryRun);
      process.exit(1);
    }
  }

  log('\n✅ Phase 1 complete - all packages published', 'green');

  // Phase 2: For stable versions, add @next tag if requested
  if (updateNext) {
    updateNextTag(version, dryRun);
  }

  cleanupManifest();

  log('\n' + '='.repeat(60), 'green');
  log('✅ PUBLISH SUCCESSFUL', 'green');
  log(`Version: ${version}`, 'green');
  log(`Primary tag: @${primaryTag}`, 'green');
  if (manifest.nextTagAdded) {
    log('@next tag: Updated', 'green');
  }
  log('='.repeat(60), 'green');

  process.exit(0);
}

main();

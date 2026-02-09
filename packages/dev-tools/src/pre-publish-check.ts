/**
 * Pre-Publish Validation Check
 *
 * This script ensures the repository is in a publishable state:
 * 1. Git repository exists
 * 2. On main branch (or explicitly allow other branches)
 * 3. No uncommitted changes (clean working tree)
 * 4. No untracked files (except allowed patterns)
 * 5. All validation checks pass
 * 6. Package list synchronized with publish script
 * 7. All packages are built
 * 8. Workspace dependencies are correct
 * 9. All packages have proper "files" field
 * 10. All packages have required metadata (repository, author, license)
 * 11. CHANGELOG.md has entry for current version (publish mode only)
 *
 * Usage:
 *   tsx tools/pre-publish-check.ts [--allow-branch BRANCH] [--skip-git-checks]
 *   bun run pre-publish [--allow-branch BRANCH] [--skip-git-checks]
 *
 * Exit codes:
 *   0 - Ready to publish
 *   1 - Not ready (with explanation)
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// File paths derived from PROJECT_ROOT and packagesDir constants (controlled, not user input)

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_ROOT, log, safeExecSync, safeExecResult } from './common.js';
import { validatePackageList } from './validate-package-list.js';

/**
 * Detect if running in CI environment
 */
function isCI(): boolean {
  // Using || for boolean coercion of env vars (empty string should be falsy)
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  return !!(process.env['CI'] || process.env['GITHUB_ACTIONS'] || process.env['GITLAB_CI'] || process.env['CIRCLECI'] || process.env['TRAVIS'] || process.env['JENKINS_URL']);
}

/**
 * Get all publishable packages (non-private packages in packages/)
 */
function getPublishablePackages(packagesDir: string): Array<{ name: string; pkgJson: Record<string, unknown> }> {
  const result: Array<{ name: string; pkgJson: Record<string, unknown> }> = [];

  if (!existsSync(packagesDir)) {
    return result;
  }

  const packages = readdirSync(packagesDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  for (const pkg of packages) {
    const pkgJsonPath = join(packagesDir, pkg, 'package.json');
    if (existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;

      // Skip private packages
      if (pkgJson['private']) {
        continue;
      }

      result.push({ name: pkg, pkgJson });
    }
  }

  return result;
}

const IS_CI = isCI();

// Parse command-line arguments
const args = process.argv.slice(2);
let allowedBranch = 'main';
let allowCustomBranch = false;
let skipGitChecks = false;

let i = 0;
while (i < args.length) {
  const nextArg = args[i + 1];
  if (args[i] === '--allow-branch' && nextArg) {
    allowedBranch = nextArg;
    allowCustomBranch = true;
    i += 2;
  } else if (args[i] === '--skip-git-checks') {
    skipGitChecks = true;
    i += 1;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Pre-Publish Validation Check

Usage:
  tsx tools/pre-publish-check.ts [OPTIONS]
  bun run pre-publish [OPTIONS]

Options:
  --allow-branch BRANCH  Allow publishing from a specific branch (default: main)
  --skip-git-checks      Skip git-related checks (branch, uncommitted changes, untracked files)
                         Use this when running in vibe-validate during development
  --help, -h             Show this help message

Exit codes:
  0 - Ready to publish
  1 - Not ready (with explanation)
    `);
    process.exit(0);
  } else {
    console.error(`Unknown option: ${String(args[i] ?? 'unknown')}`);
    console.error('Usage: tsx tools/pre-publish-check.ts [OPTIONS]');
    process.exit(1);
  }
  i++;
}

console.log(IS_CI ? '🔍 Pre-Publish Validation Check (CI Mode)' : '🔍 Pre-Publish Validation Check');
console.log('==========================================');
console.log('');

// Check 1: Git repository exists
try {
  const result = safeExecResult('git', ['rev-parse', '--git-dir'], { stdio: 'pipe' });
  if (!result.success) {
    throw new Error('Not a git repository');
  }
  log('✓ Git repository detected', 'green');
} catch (error) {
  log('✗ Not a git repository', 'red');
  const message = error instanceof Error ? error.message : '';
  if (message.includes('ENOENT')) {
    console.log('  Git executable not found. Please install git.');
  }
  process.exit(1);
}

// Check 2: Current branch (skip in CI - uses detached HEAD on tag checkout)
if (IS_CI || skipGitChecks) {
  log('⊘ Branch check skipped (CI mode or --skip-git-checks)', 'yellow');
} else {
  let currentBranch: string;
  try {
    const result = safeExecResult('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (!result.success) {
      throw new Error('Failed to determine current branch');
    }
    currentBranch = result.stdout.trim();
  } catch (error) {
    log('✗ Failed to determine current branch', 'red');
    const message = error instanceof Error ? error.message : '';
    if (message.includes('HEAD')) {
      console.log('  You may be in a detached HEAD state. Check git status.');
    }
    process.exit(1);
  }

  if (currentBranch !== allowedBranch) {
    log(`✗ Not on ${allowedBranch} branch (current: ${currentBranch})`, 'red');
    console.log(`  Tip: Run 'git checkout ${allowedBranch}' or use --allow-branch flag`);
    process.exit(1);
  }

  if (allowCustomBranch && currentBranch !== 'main') {
    log(`⚠ On branch: ${currentBranch} (explicitly allowed)`, 'yellow');
  } else {
    log('✓ On main branch', 'green');
  }
}

// Check 3: Working tree is clean (skip in CI - always starts with clean checkout)
if (IS_CI || skipGitChecks) {
  log('⊘ Uncommitted changes check skipped (CI mode or --skip-git-checks)', 'yellow');
} else {
  const result = safeExecResult('git', ['diff-index', '--quiet', 'HEAD', '--'], { stdio: 'pipe' });
  const hasUncommittedChanges = !result.success;

  if (hasUncommittedChanges) {
    log('✗ Uncommitted changes detected', 'red');
    console.log('');

    const statusResult = safeExecResult('git', ['status', '--short'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });

    if (statusResult.success) {
      console.log(statusResult.stdout);
    } else {
      console.log('  (Unable to show git status details)');
    }

    console.log('  Please commit or stash your changes before publishing');
    process.exit(1);
  }
  log('✓ No uncommitted changes', 'green');
}

// Check 4: No untracked files (skip in CI - not applicable)
if (IS_CI || skipGitChecks) {
  log('⊘ Untracked files check skipped (CI mode or --skip-git-checks)', 'yellow');
} else {
  const untrackedResult = safeExecResult('git', ['ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  let untracked = '';
  if (untrackedResult.success) {
    untracked = untrackedResult.stdout;
  } else {
    log('⚠ Warning: Could not check untracked files (git not available)', 'yellow');
  }

  if (untracked) {
    // Filter out allowed patterns
    const allowedPatterns = [
      /node_modules/,
      /dist/,
      /\.DS_Store/,
      /TODO\.md/,
    ];

    const untrackedLines = untracked.split('\n').filter(line => line.trim());
    const filteredUntracked = untrackedLines.filter(line => {
      return !allowedPatterns.some(pattern => pattern.test(line));
    });

    if (filteredUntracked.length > 0) {
      log('✗ Untracked files detected', 'red');
      console.log('');
      for (const file of filteredUntracked) {
        console.log(file);
      }
      console.log('');
      console.log('  Please add these files to git or .gitignore before publishing');
      process.exit(1);
    }
  }
  log('✓ No untracked files', 'green');
}

// Check 5: Run validation (skip when called from within vibe-validate)
if (skipGitChecks) {
  log('⊘ Validation check skipped (already running in vibe-validate)', 'yellow');
} else {
  console.log('');
  console.log('Running validation checks...');

  try {
    safeExecSync('bun', ['run', 'validate'], { stdio: 'inherit', cwd: PROJECT_ROOT });
    log('✓ All validation checks passed', 'green');
  } catch (error) {
    console.log('');
    log('✗ Validation failed', 'red');
    console.log('  Check the output above and fix all issues before publishing');
    const message = error instanceof Error ? error.message : '';
    if (message.includes('ENOENT')) {
      console.log('  (bun not found - install bun to run validation)');
    }
    process.exit(1);
  }
}

// Check 6: Package list synchronization
console.log('');
console.log('Checking package list synchronization...');

const packagesDir = join(PROJECT_ROOT, 'packages');

try {
  const validation = validatePackageList(PROJECT_ROOT);
  const hasErrors = validation.undeclared.length > 0 || validation.phantom.length > 0;

  if (hasErrors) {
    log('✗ Package list out of sync!', 'red');
    console.log('');

    if (validation.undeclared.length > 0) {
      console.log('  The following packages exist in packages/ but are not declared:');
      for (const pkg of validation.undeclared) {
        console.log(`    ${pkg}`);
      }
      console.log('');
    }

    if (validation.phantom.length > 0) {
      console.log('  The following packages are declared but do not exist in packages/:');
      for (const pkg of validation.phantom) {
        console.log(`    ${pkg}`);
      }
      console.log('');
    }

    console.log('  Update packages/dev-tools/src/package-lists.ts:');
    console.log('    - Add undeclared packages to PUBLISHED_PACKAGES or SKIP_PACKAGES');
    console.log('    - Remove phantom packages from PUBLISHED_PACKAGES and SKIP_PACKAGES');
    process.exit(1);
  }

  log('✓ All packages accounted for', 'green');
} catch (error) {
  log('✗ Failed to check package list', 'red');
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

// Check 7: Packages are built
console.log('');
console.log('Checking package builds...');

const missingBuilds: string[] = [];

try {
  const publishablePackages = getPublishablePackages(packagesDir);

  for (const { name: pkg, pkgJson } of publishablePackages) {
    // Only check for dist/ if package has a build script
    const scripts = pkgJson['scripts'] as Record<string, string> | undefined;
    const hasBuildScript = scripts?.['build'];
    if (!hasBuildScript) {
      continue;
    }

    const distDir = join(packagesDir, pkg, 'dist');
    if (!existsSync(distDir)) {
      missingBuilds.push(join('packages', pkg, ''));
    }
  }
} catch (error) {
  log('✗ Failed to check package builds', 'red');
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

if (missingBuilds.length > 0) {
  log('✗ Missing build outputs', 'red');
  for (const pkg of missingBuilds) {
    console.log(pkg);
  }
  console.log('  Run \'bun run build\' to build all packages');
  process.exit(1);
}
log('✓ All packages built', 'green');

// Check 8: Workspace dependencies (workspace:* is expected and handled by Bun during publish)
console.log('');
console.log('Checking workspace dependencies...');

try {
  const publishablePackages = getPublishablePackages(packagesDir);
  let workspaceCount = 0;

  for (const { pkgJson } of publishablePackages) {
    const allDeps = {
      ...(pkgJson['dependencies'] as Record<string, string> | undefined),
      ...(pkgJson['devDependencies'] as Record<string, string> | undefined),
      ...(pkgJson['peerDependencies'] as Record<string, string> | undefined),
    };

    for (const depVersion of Object.values(allDeps)) {
      if (typeof depVersion === 'string' && depVersion.startsWith('workspace:')) {
        workspaceCount++;
      }
    }
  }

  if (workspaceCount > 0) {
    log(`✓ Found ${workspaceCount} workspace dependencies (Bun will resolve during publish)`, 'green');
  } else {
    log('✓ No workspace dependencies', 'green');
  }
} catch (error) {
  log('✗ Failed to check workspace dependencies', 'red');
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

// Check 9: Packages have proper "files" field for npm publish
console.log('');
console.log('Checking package "files" fields...');

try {
  const publishablePackages = getPublishablePackages(packagesDir);
  const missingFiles: string[] = [];
  const missingDist: string[] = [];

  for (const { name: pkg, pkgJson } of publishablePackages) {
    const files = pkgJson['files'] as string[] | undefined;

    // Check if files field exists
    if (!files || files.length === 0) {
      missingFiles.push(pkg);
      continue;
    }

    // For packages with build scripts, verify dist is included
    const scripts = pkgJson['scripts'] as Record<string, string> | undefined;
    const hasBuildScript = scripts?.['build'];
    if (hasBuildScript) {
      const hasDistEntry = files.some(f => f === 'dist' || f === 'dist/');
      if (!hasDistEntry) {
        missingDist.push(pkg);
      }
    }

    // For packages with bin field, verify bin path is covered by files array
    const bin = pkgJson['bin'];
    if (bin) {
      const binPaths = typeof bin === 'string' ? [bin] : Object.values(bin);
      for (const binPath of binPaths) {
        // Check if bin path is covered by any entry in files array
        const isCovered = files.some(fileEntry => {
          // Normalize paths (remove leading ./)
          const normalizedBin = binPath.replace(/^\.\//, '');
          const normalizedFile = fileEntry.replace(/^\.\//, '');
          return normalizedBin.startsWith(normalizedFile + '/');
        });

        if (!isCovered && !files.includes('bin')) {
          missingFiles.push(`${pkg} (bin "${String(binPath)}" not covered by files array)`);
          break; // Only report once per package
        }
      }
    }
  }

  if (missingFiles.length > 0 || missingDist.length > 0) {
    log('✗ Some packages missing "files" configuration', 'red');
    if (missingFiles.length > 0) {
      console.log('\nPackages without "files" field:');
      for (const pkg of missingFiles) {
        console.log(`  ${pkg}`);
      }
    }
    if (missingDist.length > 0) {
      console.log('\nPackages missing "dist" in files field:');
      for (const pkg of missingDist) {
        console.log(`  ${pkg}`);
      }
    }
    console.log('\nAdd "files" field to package.json:');
    console.log('  "files": ["dist", "README.md"]');
    process.exit(1);
  }

  log('✓ All packages have proper "files" configuration', 'green');
} catch (error) {
  log('✗ Failed to check package files configuration', 'red');
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

// Check 10: Required package metadata (repository, author, license)
console.log('');
console.log('Checking required package metadata...');

try {
  const publishablePackages = getPublishablePackages(packagesDir);
  const missingMetadata: Array<{ pkg: string; missing: string[] }> = [];

  for (const { name: pkg, pkgJson } of publishablePackages) {
    const missing: string[] = [];

    // Check for repository field
    const repository = pkgJson['repository'];
    if (!repository) {
      missing.push('repository');
    } else if (typeof repository === 'object') {
      const repoObj = repository as Record<string, unknown>;
      if (!repoObj['url']) {
        missing.push('repository.url');
      }
    }

    // Check for author field
    if (!pkgJson['author']) {
      missing.push('author');
    }

    // Check for license field
    if (!pkgJson['license']) {
      missing.push('license');
    }

    if (missing.length > 0) {
      missingMetadata.push({ pkg, missing });
    }
  }

  if (missingMetadata.length > 0) {
    log('✗ Some packages missing required metadata', 'red');
    console.log('');
    console.log('  Packages with missing fields:');
    for (const { pkg, missing } of missingMetadata) {
      console.log(`    ${pkg}:`);
      for (const field of missing) {
        console.log(`      - ${field}`);
      }
    }
    console.log('');
    console.log('  Add these fields to package.json:');
    console.log('    "repository": {');
    console.log('      "type": "git",');
    console.log('      "url": "https://github.com/jdutton/vibe-agent-toolkit.git",');
    console.log('      "directory": "packages/PACKAGE_NAME"');
    console.log('    },');
    console.log('    "author": "Jeff Dutton",');
    console.log('    "license": "MIT"');
    process.exit(1);
  }

  log('✓ All packages have required metadata', 'green');
} catch (error) {
  log('✗ Failed to check package metadata', 'red');
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

// Check 11: CHANGELOG.md has entry for current version (skip in development mode)
if (skipGitChecks) {
  log('⊘ CHANGELOG check skipped (development mode)', 'yellow');
} else {
  console.log('');
  console.log('Checking CHANGELOG.md...');

  try {
    // Read version from umbrella package (monorepo canonical version)
    const umbrellaPkgJsonPath = join(packagesDir, 'vibe-agent-toolkit', 'package.json');
    if (!existsSync(umbrellaPkgJsonPath)) {
      throw new Error('Umbrella package (vibe-agent-toolkit) package.json not found');
    }

    const umbrellaPkgJson = JSON.parse(readFileSync(umbrellaPkgJsonPath, 'utf8')) as Record<string, unknown>;
    const version = umbrellaPkgJson['version'];
    if (typeof version !== 'string') {
      throw new TypeError('Version not found in umbrella package (vibe-agent-toolkit) package.json');
    }

    // Read CHANGELOG.md
    const changelogPath = join(PROJECT_ROOT, 'CHANGELOG.md');
    if (!existsSync(changelogPath)) {
      log('✗ CHANGELOG.md not found', 'red');
      console.log('  Create CHANGELOG.md to document releases');
      process.exit(1);
    }

    // Skip CHANGELOG check for prerelease versions (RC, alpha, beta, etc.)
    const isPrerelease = /-(rc|alpha|beta|dev|canary)\./i.test(version);
    if (isPrerelease) {
      log(`⊘ CHANGELOG check skipped (prerelease version: ${version})`, 'yellow');
    } else {
      const changelogContent = readFileSync(changelogPath, 'utf8');

      // Look for version entry: ## [X.Y.Z] - YYYY-MM-DD
      // Escape dots in version string for regex matching
      const escapedVersion = version.replaceAll('.', String.raw`\.`);
      // eslint-disable-next-line security/detect-non-literal-regexp -- version from package.json is trusted
      const versionPattern = new RegExp(String.raw`^## \[${escapedVersion}\] - \d{4}-\d{2}-\d{2}`, 'm');

      if (!versionPattern.test(changelogContent)) {
        log(`✗ CHANGELOG.md missing entry for version ${version}`, 'red');
        console.log('');
        console.log('  Recovery instructions:');
        console.log(`  1. Add version entry to CHANGELOG.md:`);
        console.log(`     ## [${version}] - ${String(new Date().toISOString().split('T')[0] ?? '')}`);
        console.log('  2. Document changes under the version header');
        console.log('  3. Run pre-publish-check again');
        console.log('');
        process.exit(1);
      }

      log(`✓ CHANGELOG.md has entry for version ${version}`, 'green');
    }
  } catch (error) {
    log('✗ Failed to check CHANGELOG.md', 'red');
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

// Success!
console.log('');
log('✅ Repository is ready to publish!', 'green');
console.log('');
console.log('Next steps:');
console.log('  1. Update package versions: bun run bump-version patch (or minor/major)');
console.log('  2. Commit version changes: git commit -am \'Release vX.Y.Z\'');
console.log('  3. Create git tag: git tag -a vX.Y.Z -m \'Release vX.Y.Z\'');
console.log('  4. Push to GitHub: git push origin main --tags');
console.log('  5. Publish to npm: (add your publish script)');
console.log('');

process.exit(0);

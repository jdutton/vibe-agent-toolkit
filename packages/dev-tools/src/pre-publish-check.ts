/**
 * Pre-Publish Validation Check
 *
 * This script ensures the repository is in a publishable state:
 * 1. No uncommitted changes (clean working tree)
 * 2. No untracked files (except allowed patterns)
 * 3. All validation checks pass
 * 4. On main branch (or explicitly allow other branches)
 *
 * Usage:
 *   tsx tools/pre-publish-check.ts [--allow-branch BRANCH]
 *   bun run pre-publish [--allow-branch BRANCH]
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

/**
 * Detect if running in CI environment
 */
function isCI(): boolean {
  // Using || for boolean coercion of env vars (empty string should be falsy)
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  return !!(process.env['CI'] || process.env['GITHUB_ACTIONS'] || process.env['GITLAB_CI'] || process.env['CIRCLECI'] || process.env['TRAVIS'] || process.env['JENKINS_URL']);
}

const IS_CI = isCI();

// Parse command-line arguments
const args = process.argv.slice(2);
let allowedBranch = 'main';
let allowCustomBranch = false;

let i = 0;
while (i < args.length) {
  const nextArg = args[i + 1];
  if (args[i] === '--allow-branch' && nextArg) {
    allowedBranch = nextArg;
    allowCustomBranch = true;
    i += 2;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Pre-Publish Validation Check

Usage:
  tsx tools/pre-publish-check.ts [--allow-branch BRANCH]
  bun run pre-publish [--allow-branch BRANCH]

Options:
  --allow-branch BRANCH  Allow publishing from a specific branch (default: main)
  --help, -h            Show this help message

Exit codes:
  0 - Ready to publish
  1 - Not ready (with explanation)
    `);
    process.exit(0);
  } else {
    console.error(`Unknown option: ${args[i]}`);
    console.error('Usage: tsx tools/pre-publish-check.ts [--allow-branch BRANCH]');
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
if (IS_CI) {
  log('⊘ Branch check skipped (CI mode)', 'yellow');
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
if (IS_CI) {
  log('⊘ Uncommitted changes check skipped (CI mode)', 'yellow');
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
if (IS_CI) {
  log('⊘ Untracked files check skipped (CI mode)', 'yellow');
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

// Check 5: Run validation
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

// Check 6: Packages are built
console.log('');
console.log('Checking package builds...');

const packagesDir = join(PROJECT_ROOT, 'packages');
const missingBuilds: string[] = [];

try {
  if (existsSync(packagesDir)) {
    const packages = readdirSync(packagesDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const pkg of packages) {
      // Check if package is private (skip build check for private packages)
      const pkgJsonPath = join(packagesDir, pkg, 'package.json');
      if (existsSync(pkgJsonPath)) {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));

        // Skip private packages
        if (pkgJson.private) {
          continue;
        }
      }

      const distDir = join(packagesDir, pkg, 'dist');
      if (!existsSync(distDir)) {
        missingBuilds.push(join('packages', pkg, ''));
      }
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

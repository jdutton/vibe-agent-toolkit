/**
 * Run a command in all workspace packages
 *
 * Usage:
 *   tsx tools/run-in-packages.ts build
 *   tsx tools/run-in-packages.ts typecheck
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// File paths derived from PROJECT_ROOT and packagesDir constants (controlled, not user input)

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import which from 'which';

import { PROJECT_ROOT, log } from './common.js';

// Get command from arguments
const command = process.argv[2];
if (!command) {
  console.error('Usage: tsx tools/run-in-packages.ts <command>');
  process.exit(1);
}

// Discover all packages
const packagesDir = join(PROJECT_ROOT, 'packages');
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter(dirent => dirent.isDirectory())
  .map(dirent => dirent.name)
  .sort((a, b) => a.localeCompare(b));

if (packages.length === 0) {
  log('No packages found in packages/ directory', 'yellow');
  process.exit(0);
}

log(`Running '${command}' in ${packages.length} package(s)`, 'blue');
console.log('');

let failedPackages = 0;

// Run command in each package
for (const pkg of packages) {
  const pkgDir = join(packagesDir, pkg);
  const pkgJsonPath = join(pkgDir, 'package.json');

  if (!existsSync(pkgJsonPath)) {
    log(`  - ${pkg}: skipped (no package.json)`, 'yellow');
    continue;
  }

  // Check if package has this script
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  if (!pkgJson.scripts?.[command]) {
    log(`  - ${pkg}: skipped (no '${command}' script)`, 'yellow');
    continue;
  }

  // Run the command
  log(`  → ${pkg}`, 'reset');
  // Resolve bun path for security
  const bunPath = which.sync('bun');
  const result = spawnSync(bunPath, ['run', command], {
    cwd: pkgDir,
    stdio: 'inherit',
    shell: false,
  });

  if (result.status === 0) {
    log(`  ✓ ${pkg}: passed`, 'green');
  } else {
    log(`  ✗ ${pkg}: failed`, 'red');
    failedPackages++;
  }
  console.log('');
}

// Report results
if (failedPackages > 0) {
  log(`❌ ${failedPackages} package(s) failed`, 'red');
  process.exit(1);
} else {
  log(`✅ All packages passed`, 'green');
  process.exit(0);
}

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
const allPackages = readdirSync(packagesDir, { withFileTypes: true })
  .filter(dirent => dirent.isDirectory())
  .map(dirent => dirent.name);

if (allPackages.length === 0) {
  log('No packages found in packages/ directory', 'yellow');
  process.exit(0);
}

/**
 * Build dependency graph from package.json files
 * Returns Map<package, Set<dependencies>>
 */
function buildDependencyGraph(packages: string[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  for (const pkg of packages) {
    const pkgJsonPath = join(packagesDir, pkg, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      graph.set(pkg, new Set());
      continue;
    }

    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    const deps = new Set<string>();

    // Check workspace dependencies
    const allDeps = {
      ...pkgJson.dependencies,
      ...pkgJson.devDependencies,
    };

    for (const [depName, depVersion] of Object.entries(allDeps)) {
      // Only care about workspace:* dependencies
      if (typeof depVersion === 'string' && depVersion.startsWith('workspace:')) {
        // Extract package name from @vibe-agent-toolkit/packagename
        const regex = /@vibe-agent-toolkit\/(.+)/;
        const match = regex.exec(depName);
        const pkgName = match?.[1];
        if (pkgName && packages.includes(pkgName)) {
          deps.add(pkgName);
        }
      }
    }

    graph.set(pkg, deps);
  }

  return graph;
}

/**
 * Calculate in-degree for each package (number of dependencies)
 */
function calculateInDegree(packages: string[], graph: Map<string, Set<string>>): Map<string, number> {
  const inDegree = new Map<string, number>();
  for (const pkg of packages) {
    // In-degree = how many packages THIS package depends on
    inDegree.set(pkg, graph.get(pkg)?.size ?? 0);
  }
  return inDegree;
}

/**
 * Get packages with no dependencies (starting points for topological sort)
 */
function getPackagesWithNoDependencies(packages: string[], inDegree: Map<string, number>): string[] {
  const queue: string[] = [];
  for (const pkg of packages) {
    if (inDegree.get(pkg) === 0) {
      queue.push(pkg);
    }
  }
  return queue;
}

/**
 * Add any remaining packages (circular dependencies) to sorted list
 */
function handleCircularDependencies(packages: string[], sorted: string[]): void {
  if (sorted.length !== packages.length) {
    log('Warning: Circular dependencies detected, using partial sort', 'yellow');
    // Add remaining packages alphabetically
    for (const pkg of packages) {
      if (!sorted.includes(pkg)) {
        sorted.push(pkg);
      }
    }
  }
}

/**
 * Topological sort using Kahn's algorithm
 * Returns packages in dependency order (dependencies before dependents)
 */
function topologicalSort(packages: string[], graph: Map<string, Set<string>>): string[] {
  const inDegree = calculateInDegree(packages, graph);
  const queue = getPackagesWithNoDependencies(packages, inDegree);
  const sorted: string[] = [];

  while (queue.length > 0) {
    // Process packages with no remaining dependencies (alphabetically for determinism)
    queue.sort((a, b) => a.localeCompare(b));
    const pkg = queue.shift();
    if (!pkg) {
      break;
    }
    sorted.push(pkg);

    // Reduce in-degree for packages that depend on this one
    for (const [otherPkg, deps] of graph.entries()) {
      if (deps.has(pkg)) {
        const newInDegree = (inDegree.get(otherPkg) ?? 0) - 1;
        inDegree.set(otherPkg, newInDegree);
        if (newInDegree === 0) {
          queue.push(otherPkg);
        }
      }
    }
  }

  handleCircularDependencies(packages, sorted);
  return sorted;
}

// Sort packages by dependency order
const dependencyGraph = buildDependencyGraph(allPackages);
const packages = topologicalSort(allPackages, dependencyGraph);

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

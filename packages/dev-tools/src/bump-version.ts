/**
 * Version Bump Script
 *
 * Updates the `version` field in the root `package.json` and every workspace
 * package manifest, updates `bun.lock`, and — for a STABLE version — stamps
 * `CHANGELOG.md`: the `[Unreleased]` body plus every `.changes/*.md` fragment
 * moves under a new `## [X.Y.Z] - date` heading and the fragments are deleted.
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
 * A manifest already at the target version is left untouched (not rewritten
 * byte-for-byte), so a re-run is a no-op diff.
 *
 * `workspace:*` specifiers are NOT rewritten here — and NOT by Bun at publish
 * time either, whatever an older comment here said: `npm publish` ships the
 * manifest verbatim, which is how `@vibe-agent-toolkit/cli@0.2.0-rc.3` reached
 * the registry with raw `workspace:*` entries npm cannot install. The publish
 * workflow runs `resolve-workspace-deps` for that, on a checkout nobody commits.
 *
 * 🔑 Why every manifest still carries its own `version` (the readers, so the
 * next person can make the per-package field a publish-time stamp instead):
 *   1. `npm publish` — reads the manifest in each package directory; never the tag.
 *   2. `validate-version.ts` — asserts all manifests agree (a check that exists
 *      only because there are 26 copies).
 *   3. `packages/cli/src/version.ts` — `vat --version` reads its own manifest at runtime.
 *   4. `packages/resources/src/cache-namespace.ts` — the parse cache is namespaced
 *      by the package version, so every bump invalidates every adopter's cache.
 * The first three are satisfied by a stamp written at publish time (where
 * `resolve-workspace-deps` already rewrites every manifest); the fourth reads
 * whatever the manifest says at publish, which is the same stamp.
 *
 * Exit codes:
 *   0 - Success
 *   1 - Error (invalid version, file not found, etc.)
 */

// File paths derived from PROJECT_ROOT (controlled, not user input)

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';


import { ExitCode } from '@vibe-agent-toolkit/schema';
import { direntKindFollowingSync, safePath } from '@vibe-agent-toolkit/utils';
import { safeExecSync } from '@vibe-agent-toolkit/utils/process';
import semver from 'semver';

import { deleteFragments, mergeFragmentsIntoBody, readFragments } from './changelog-fragments.js';
import { PROJECT_ROOT, log, processWorkspacePackages, type PackageProcessResult } from './common.js';

const PACKAGE_JSON = 'package.json';
const CHANGELOG_PATH = safePath.join(PROJECT_ROOT, 'CHANGELOG.md');
const UNRELEASED_HEADING = '## [Unreleased]';

interface ChangelogUnreleasedSection {
  content: string;
  body: string;
  unreleasedIndex: number;
  afterHeading: number;
  nextSectionOffset: number;
}

function parseChangelogUnreleased(): ChangelogUnreleasedSection {
  const content = readFileSync(CHANGELOG_PATH, 'utf8');
  const unreleasedIndex = content.indexOf(UNRELEASED_HEADING);
  if (unreleasedIndex === -1) {
    throw new Error('CHANGELOG.md is missing the [Unreleased] section');
  }
  const afterHeading = unreleasedIndex + UNRELEASED_HEADING.length;
  const nextSectionMatch = /\n## \[/.exec(content.slice(afterHeading));
  const nextSectionOffset = nextSectionMatch?.index ?? content.slice(afterHeading).length;
  const body = content.slice(afterHeading, afterHeading + nextSectionOffset);
  return { content, body, unreleasedIndex, afterHeading, nextSectionOffset };
}

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
  2 - Error (invalid version, file not found, etc.)
  `);
  process.exit(args.length === 0 ? ExitCode.ERROR : ExitCode.OK);
}

// After help check, we know args.length > 0
const versionArg = args[0];
if (!versionArg) {
  log('✗ Version argument is required', 'red');
  process.exit(ExitCode.ERROR);
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
    const rootPkgPath = safePath.join(PROJECT_ROOT, PACKAGE_JSON);
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
    const currentVersion = rootPkg.version;

    if (!currentVersion) {
      log('✗ Could not determine current version from root package.json', 'red');
      process.exit(ExitCode.ERROR);
    }

    newVersion = incrementVersion(currentVersion, versionArg);
    log(`Current version: ${String(currentVersion)}`, 'blue');
    log(`Increment type: ${String(versionArg)}`, 'blue');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`✗ Failed to read current version: ${message}`, 'red');
    process.exit(ExitCode.ERROR);
  }
} else {
  // Explicit version provided
  newVersion = versionArg;

  // Validate version format using semver
  if (!semver.valid(newVersion)) {
    log(`✗ Invalid version format: ${newVersion}`, 'red');
    log('  Expected format: X.Y.Z or X.Y.Z-prerelease', 'yellow');
    log('  Examples: 1.0.0, 2.0.0, 1.0.0-beta.1, patch, minor, major', 'yellow');
    process.exit(ExitCode.ERROR);
  }
}

// Pre-flight: validate CHANGELOG before touching any files (prevents dirty state on failure)
const isPrerelease = semver.prerelease(newVersion) !== null;
if (!isPrerelease) {
  try {
    const { content, body } = parseChangelogUnreleased();

    // Safety: refuse to stamp if this version already exists in CHANGELOG
    const escapedVersion = newVersion.replaceAll('.', String.raw`\.`);
    // eslint-disable-next-line security/detect-non-literal-regexp -- version is from CLI arg, already validated by semver
    const existingPattern = new RegExp(String.raw`^## \[${escapedVersion}\]`, 'm');
    if (existingPattern.test(content)) {
      log(`✗ CHANGELOG.md already has an entry for [${newVersion}]. Refusing to stamp to avoid corruption.`, 'red');
      console.log('  If you need to re-stamp, manually remove the existing entry first.');
      process.exit(ExitCode.ERROR);
    }

    const { fragments, problems } = readFragments(PROJECT_ROOT);
    if (problems.length > 0) {
      log('✗ Malformed changelog fragment(s) under .changes/ — fix them before stamping:', 'red');
      for (const problem of problems) console.log(`  ${problem.reason}`);
      process.exit(ExitCode.ERROR);
    }

    if (!body.trim() && fragments.length === 0) {
      log('✗ CHANGELOG.md has no content under [Unreleased] and .changes/ holds no fragments. Add release notes before bumping to a stable version.', 'red');
      process.exit(ExitCode.ERROR);
    }

    log(`✓ CHANGELOG.md pre-flight check passed (${fragments.length} fragment(s) to fold in)`, 'green');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`✗ Failed to validate CHANGELOG.md: ${message}`, 'red');
    process.exit(ExitCode.ERROR);
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

    // Preserve original formatting by replacing only the version line.
    // `workspace:*` specifiers stay as they are — see the header for who
    // resolves them, and when.
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
const rootPackagePath = safePath.join(PROJECT_ROOT, PACKAGE_JSON);
log('Updating root package.json...', 'blue');

try {
  const result = updatePackageVersion(rootPackagePath, newVersion);
  if (result.skipped) {
    log(`  - ${result.name ?? 'root'}: skipped (${String(result.reason ?? 'unknown')})`, 'yellow');
  } else if (result.updated) {
    log(`  ✓ ${result.name ?? 'root'}: ${String(result.oldVersion ?? 'unknown')} → ${String(result.newVersion ?? 'unknown')}`, 'green');
  } else {
    log(`  - ${result.name ?? 'root'}: already at ${String(result.newVersion ?? 'unknown')}`, 'yellow');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`  ✗ ${message}`, 'red');
  process.exit(ExitCode.ERROR);
}

console.log('');
log('Updating workspace packages...', 'blue');

// A missing packages directory is the only "no packages" case; a directory
// that is there but cannot be listed stays loud.
const packagesDir = safePath.join(PROJECT_ROOT, 'packages');
const hasPackages =
  existsSync(packagesDir) &&
  readdirSync(packagesDir, { withFileTypes: true }).some((dirent) => direntKindFollowingSync(packagesDir, dirent) === 'directory');

if (hasPackages) {
  // Update all workspace packages
  const counts = processWorkspacePackages<VersionUpdateResult>(
    (pkgPath) => updatePackageVersion(pkgPath, newVersion),
    (result) => {
      if (result.updated) {
        log(`  ✓ ${String(result.name ?? 'unknown')}: ${String(result.oldVersion ?? 'unknown')} → ${String(result.newVersion ?? 'unknown')}`, 'green');
      } else {
        log(`  - ${String(result.name ?? 'unknown')}: already at ${String(result.newVersion ?? 'unknown')}`, 'yellow');
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

// Update bun.lock to reflect version changes
log('Updating bun.lock...', 'blue');
try {
  safeExecSync('bun', ['install', '--lockfile-only'], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'], // stdin: ignore to prevent hanging in pipes/bg
  });
  log('  ✓ bun.lock updated', 'green');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`  ✗ Failed to update bun.lock: ${message}`, 'red');
  log('  You may need to run "bun install" manually', 'yellow');
}

// Stamp CHANGELOG.md for stable releases (pre-flight already validated, just do the write)
if (isPrerelease) {
  log('⊘ CHANGELOG stamp skipped (prerelease version)', 'yellow');
} else {
  try {
    const { content, body, afterHeading, nextSectionOffset } = parseChangelogUnreleased();
    const today = new Date().toISOString().split('T')[0] ?? '';
    const versionHeading = `## [${newVersion}] - ${today}`;

    // Pre-flight already refused malformed fragments, so only fragments are left.
    const { fragments } = readFragments(PROJECT_ROOT);
    const merged = mergeFragmentsIntoBody(body.replace(/^\n/, ''), fragments);

    const before = content.slice(0, afterHeading);
    const after = content.slice(afterHeading + nextSectionOffset);
    const updatedChangelog = `${before}\n\n${versionHeading}\n${merged}${after}`;

    writeFileSync(CHANGELOG_PATH, updatedChangelog, 'utf8');
    deleteFragments(PROJECT_ROOT, fragments);
    const folded = fragments.length > 0 ? ` (${fragments.length} fragment(s) folded in and deleted)` : '';
    log(`✓ CHANGELOG.md stamped for v${newVersion}${folded}`, 'green');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`✗ Failed to stamp CHANGELOG.md: ${message}`, 'red');
    process.exit(ExitCode.ERROR);
  }
}

console.log('');
console.log('Next steps:');
console.log(`  1. Review changes: git diff`);
console.log(`  2. Commit: git add -A && git commit -m "chore: bump version to v${newVersion}"`);
if (isPrerelease) {
  console.log(`  3. Push: git push origin main`);
  console.log(`  (RC versions are not tagged — content stays under [Unreleased] in CHANGELOG)`);
} else {
  console.log(`  3. Merge to main, then run: bun run pre-release`);
  console.log(`  4. Only after pre-release passes: git tag v${newVersion}`);
  console.log(`  5. Push: git push origin main v${newVersion}`);
  console.log('');
  log('⚠ Do NOT tag until bun run pre-release passes. Tags trigger CI publish.', 'yellow');
}
console.log('');

process.exit(ExitCode.OK);

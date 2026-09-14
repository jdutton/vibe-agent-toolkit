#!/usr/bin/env tsx
/**
 * Creates Node.js-compatible symlinks for workspace packages
 *
 * Problem: Bun workspaces use internal resolution that Node.js can't see.
 * Solution: Create symlinks in node_modules/@vibe-agent-toolkit/ so that
 * Node.js can resolve workspace packages by name.
 *
 * This is required for:
 * - System tests that spawn CLI with `node` (not `bun`)
 * - Runtime usage where users run CLI with `node`
 * - MCP gateway imports that use package names
 *
 * Usage:
 *   bun packages/dev-tools/src/link-workspace-packages.ts
 *   tsx packages/dev-tools/src/link-workspace-packages.ts
 *
 * This runs automatically via postinstall hook in root package.json
 */

/* eslint-disable local/no-raw-node-path -- Runs at postinstall before build; cannot import safePath from utils */

import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

// Find repo root (3 levels up from packages/dev-tools/src/)
const REPO_ROOT = resolve(__dirname, '../../..');
const WORKSPACE_SCOPE = '@vibe-agent-toolkit';
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const NODE_MODULES_DIR = join(REPO_ROOT, 'node_modules');

/**
 * Every workspace package, read from the directory rather than typed in.
 *
 * The hand list this replaced said "All workspace packages" and was four short
 * (`claude-marketplace`, `lab`, `projection-sqlite`, `test-agents` were added
 * to `packages/` over seven months and never here), which only worked because
 * Bun happens to place per-dependent links under `packages/<x>/node_modules/`.
 * A directory with a `package.json` is a workspace; nothing else is.
 *
 * Dependency-free on purpose: this runs at postinstall, before any package is
 * built, so it cannot reach the workspace-graph reader in this same package.
 */
function listWorkspacePackages(): string[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    // Followed, inline: this runs before `@vibe-agent-toolkit/utils` is built,
    // so `direntKindFollowingSync` is out of reach here.
    .filter((entry) => (entry.isSymbolicLink() ? statSync(join(PACKAGES_DIR, entry.name)).isDirectory() : entry.isDirectory())
      && existsSync(join(PACKAGES_DIR, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function ensureScopeDirectory(scopeDir: string): void {
  if (!existsSync(scopeDir)) {
    // eslint-disable-next-line local/no-fs-mkdirSync -- Cannot import utils during postinstall (before build)
    mkdirSync(scopeDir, { recursive: true });
    console.log(`📁 Created ${WORKSPACE_SCOPE}/`);
  }
}

function removeExistingSymlink(linkPath: string, packageName: string): void {
  if (!existsSync(linkPath)) {
    return;
  }

  try {
    const stats = lstatSync(linkPath);
    if (stats.isSymbolicLink()) {
      unlinkSync(linkPath);
    }
  } catch (error) {
    // Warn-and-continue: `linkPackage` below retries the link and reports its
    // own failure. The reason is printed so a refusal (EPERM on a junction
    // Windows will not let this user remove) reads differently from a link
    // that vanished between the existsSync and the lstat.
    console.warn(
      `⚠️  Could not remove existing link: ${packageName} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function linkPackage(packageName: string, scopeDir: string): boolean {
  const packageDir = join(PACKAGES_DIR, packageName);
  const linkPath = join(scopeDir, packageName);

  if (!existsSync(packageDir)) {
    console.warn(`⚠️  Package not found: ${packageName} (skipping)`);
    return false;
  }

  removeExistingSymlink(linkPath, packageName);

  try {
    // On Windows, directory symlinks require elevated privileges (SeCreateSymbolicLinkPrivilege).
    // Junctions don't require admin and work identically for local paths.
    // Junctions require absolute targets (not relative), so resolve the path.
    const isWindows = process.platform === 'win32';
    const target = isWindows
      ? resolve(PACKAGES_DIR, packageName)       // absolute for junction
      : join('..', '..', 'packages', packageName); // relative for symlink
    // eslint-disable-next-line local/no-bare-symlink-in-tests -- eyes open: this IS the junction-on-win32 form the rule asks for, and the catch below reports the failure by package name.
    symlinkSync(target, linkPath, isWindows ? 'junction' : 'dir');
    return true;
  } catch (error) {
    console.error(`❌ Failed to link ${packageName}:`, error instanceof Error ? error.message : String(error));
    return false;
  }
}

function main() {
  const scopeDir = join(NODE_MODULES_DIR, WORKSPACE_SCOPE);
  ensureScopeDirectory(scopeDir);

  const workspacePackages = listWorkspacePackages();
  let linked = 0;
  for (const packageName of workspacePackages) {
    if (linkPackage(packageName, scopeDir)) {
      linked++;
    }
  }

  const total = workspacePackages.length;
  const skipped = total - linked;

  console.log(`✅ Linked ${linked}/${total} workspace package(s)`);
  if (skipped > 0) {
    console.log(`⏭️  Skipped ${skipped} package(s) (not found)`);
  }
}

main();

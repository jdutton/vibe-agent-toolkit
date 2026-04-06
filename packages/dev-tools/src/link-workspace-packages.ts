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

/* eslint-disable security/detect-non-literal-fs-filename -- All paths derived from curated WORKSPACE_PACKAGES list */

import { existsSync, mkdirSync, symlinkSync, unlinkSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

const __filename = fileURLToPath(import.meta.url);
const __dirname = safePath.resolve(__filename, '..');

// Find repo root (3 levels up from packages/dev-tools/src/)
const REPO_ROOT = safePath.resolve(__dirname, '../../..');
const WORKSPACE_SCOPE = '@vibe-agent-toolkit';
const PACKAGES_DIR = safePath.join(REPO_ROOT, 'packages');
const NODE_MODULES_DIR = safePath.join(REPO_ROOT, 'node_modules');

// All workspace packages that need Node.js-compatible symlinks
const WORKSPACE_PACKAGES = [
  'agent-config',
  'agent-runtime',
  'agent-schema',
  'agent-skills',
  'cli',
  'dev-tools',
  'discovery',
  'gateway-mcp',
  'rag',
  'rag-lancedb',
  'resource-compiler',
  'resources',
  'runtime-claude-agent-sdk',
  'runtime-langchain',
  'runtime-openai',
  'runtime-vercel-ai-sdk',
  'transports',
  'utils',
  'vat-development-agents',
  'vat-example-cat-agents',
];

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
  } catch {
    // Acceptable: old links may be stale or inaccessible
    console.warn(`⚠️  Could not remove existing link: ${packageName}`);
  }
}

function linkPackage(packageName: string, scopeDir: string): boolean {
  const packageDir = safePath.join(PACKAGES_DIR, packageName);
  const linkPath = safePath.join(scopeDir, packageName);

  if (!existsSync(packageDir)) {
    console.warn(`⚠️  Package not found: ${packageName} (skipping)`);
    return false;
  }

  removeExistingSymlink(linkPath, packageName);

  const relativePath = safePath.join('..', '..', 'packages', packageName);
  try {
    symlinkSync(relativePath, linkPath, 'dir');
    return true;
  } catch (error) {
    console.error(`❌ Failed to link ${packageName}:`, error instanceof Error ? error.message : String(error));
    return false;
  }
}

function main() {
  const scopeDir = safePath.join(NODE_MODULES_DIR, WORKSPACE_SCOPE);
  ensureScopeDirectory(scopeDir);

  let linked = 0;
  for (const packageName of WORKSPACE_PACKAGES) {
    if (linkPackage(packageName, scopeDir)) {
      linked++;
    }
  }

  const total = WORKSPACE_PACKAGES.length;
  const skipped = total - linked;

  console.log(`✅ Linked ${linked}/${total} workspace package(s)`);
  if (skipped > 0) {
    console.log(`⏭️  Skipped ${skipped} package(s) (not found)`);
  }
}

main();

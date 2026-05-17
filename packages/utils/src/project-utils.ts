/**
 * Canonical root-discovery primitives for VAT.
 *
 * Per spec docs/superpowers/specs/2026-05-17-root-model-and-leading-slash-design.md §6,
 * these are CLI-boundary functions: inner libraries take roots as parameters, not these.
 * All return `string | null` with no internal fallbacks.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, parse } from 'node:path';

import { safePath } from './path-utils.js';

const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';
const PACKAGE_JSON_FILENAME = 'package.json';

/**
 * Find the nearest vibe-agent-toolkit.config.yaml by walking up from startDir.
 *
 * Returns the path to the config file itself (not its directory). Returns null
 * if no config exists in any ancestor.
 *
 * @param startDir - Directory to start the walk from
 * @returns Path to the config file, or null if not found
 */
export function findConfigFile(startDir: string): string | null {
  let current = safePath.resolve(startDir);
  const root = parse(current).root;
  while (true) {
    const candidate = safePath.join(current, CONFIG_FILENAME);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walk-up is intentional
    if (existsSync(candidate)) return candidate;
    if (current === root) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Find the nearest package.json with a "workspaces" key by walking up.
 *
 * Used for Node-monorepo binary discovery and Node-specific tooling only.
 * NOT a substitute for findProjectRoot — VAT projects are not required to be
 * npm workspaces. Returns null when no workspaces-bearing package.json is found.
 *
 * @param startDir - Directory to start the walk from
 * @returns Path to the workspace root directory, or null if not found
 */
export function findNodeWorkspaceRoot(startDir: string): string | null {
  let current = safePath.resolve(startDir);
  while (current !== dirname(current)) {
    const pkgPath = safePath.join(current, PACKAGE_JSON_FILENAME);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walk-up is intentional
    if (existsSync(pkgPath)) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- walk-up is intentional
        const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (typeof parsed === 'object' && parsed !== null && 'workspaces' in parsed) {
          return current;
        }
      } catch {
        // Invalid JSON — skip and continue walking up.
      }
    }
    current = dirname(current);
  }
  return null;
}

/**
 * Find the VAT project root.
 *
 * Discovery ladder (checks startDir itself first, then each ancestor):
 *   1. Directory containing vibe-agent-toolkit.config.yaml → that directory
 *   2. Directory containing .git/                          → that directory
 *   3. null
 *
 * Each ladder rung is an independent walk-up. The nearest config-anchored
 * ancestor wins even if a .git/ ancestor is closer (rationale: config-file
 * placement is a stronger declaration of intent than the git boundary).
 *
 * NOTE: Phase 5 of the root-model implementation adds a module-level cache.
 * This Phase 1 version is uncached — correctness only.
 *
 * @param startDir - Directory to start the walk from
 * @returns Project root directory, or null if neither config nor git root found
 */
export function findProjectRoot(startDir: string): string | null {
  const configPath = findConfigFile(startDir);
  if (configPath !== null) return dirname(configPath);

  // Inline git-root walk to avoid an additional module-level dependency.
  let current = safePath.resolve(startDir);
  const root = parse(current).root;
  while (true) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walk-up is intentional
    if (existsSync(safePath.join(current, '.git'))) return current;
    if (current === root) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

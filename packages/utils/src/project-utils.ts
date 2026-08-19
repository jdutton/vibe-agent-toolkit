/**
 * Canonical root-discovery primitives for VAT.
 *
 * These are CLI-BOUNDARY functions: inner libraries take a root as a parameter
 * rather than discovering one. All return `string | null` with no internal
 * fallbacks — a caller with no root must decide one rather than silently
 * falling back to an absolute path.
 */

import { existsSync } from 'node:fs';
import { dirname, parse } from 'node:path';

import { resetGitRootCache } from './git-root-cache.js';
import { safePath } from './path-utils.js';
import { readTextContentSync } from './text-file.js';

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
        // Through the decoding seam: this is the ADOPTER's manifest, not ours,
        // and a UTF-8 BOM in front of `{` makes `JSON.parse` throw — which the
        // `catch` below would silently report as "not the workspace root".
        const parsed: unknown = JSON.parse(readTextContentSync(pkgPath).text);
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
 * Layer 1 cache for {@link findProjectRoot}.
 *
 * Each entry answers a property *of the keyed directory*: "what `projectRoot`
 * governs files at or below this dir?" Because the answer is independent of
 * where a walk-up started, entries can be safely shared across starting
 * points.
 *
 * Tests that mutate fixtures between runs (or in-process callers that
 * re-enter `vat audit` in the same process) must call
 * {@link resetProjectRootCaches} to invalidate this cache.
 */
const walkUpCache: Map<string, { configRoot: string | null }> = new Map();

/**
 * Reset the module-level walk-up caches: {@link findProjectRoot}'s, and the git
 * root memo behind `gitFindRoot`.
 *
 * Call at the start of each independent CLI invocation so in-process callers
 * (and integration tests sharing a vitest worker) don't observe stale results.
 *
 * Both caches are cleared by this one function on purpose. They memoize the same
 * kind of fact — which ancestor governs a directory — and are invalidated by the
 * same events, so a caller that had to remember two reset names would sooner or
 * later remember only one.
 */
export function resetProjectRootCaches(): void {
  walkUpCache.clear();
  resetGitRootCache();
}

/** Write `entry` into walkUpCache for every dir in `visited`. */
function propagateCache(visited: ReadonlyArray<string>, entry: { configRoot: string | null }): void {
  for (const dir of visited) walkUpCache.set(dir, entry);
}

/**
 * Config-anchored walk-up phase. Walks ancestors of `startDir`, populating
 * `visited` and consulting/writing the walk-up cache.
 *
 * Returns one of three results:
 * - `{ kind: 'found', configRoot }` — a config or cache hit produced an
 *   answer; cache has already been propagated to all visited dirs.
 * - `{ kind: 'exhausted' }` — reached filesystem root without finding a
 *   config; the caller should run the git-anchored phase.
 *
 * @returns walk result
 */
function configWalkPhase(
  startDir: string,
  visited: string[],
): { kind: 'found'; configRoot: string | null } | { kind: 'exhausted' } {
  let current = safePath.resolve(startDir);
  while (true) {
    const cached = walkUpCache.get(current);
    if (cached !== undefined) {
      propagateCache(visited, cached);
      return { kind: 'found', configRoot: cached.configRoot };
    }
    visited.push(current);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walk-up is intentional
    if (existsSync(safePath.join(current, CONFIG_FILENAME))) {
      const entry = { configRoot: current };
      propagateCache(visited, entry);
      return { kind: 'found', configRoot: current };
    }

    const parent = dirname(current);
    if (parent === current) return { kind: 'exhausted' };
    current = parent;
  }
}

/**
 * Git-anchored walk-up phase. Only runs after `configWalkPhase` reports
 * `exhausted`. Walks the same chain looking for `.git/` and writes the final
 * answer (the .git dir or null) into walkUpCache for every visited dir.
 */
function gitWalkPhase(startDir: string, visited: ReadonlyArray<string>): string | null {
  let current = safePath.resolve(startDir);
  while (true) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walk-up is intentional
    if (existsSync(safePath.join(current, '.git'))) {
      const entry = { configRoot: current };
      propagateCache(visited, entry);
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      propagateCache(visited, { configRoot: null });
      return null;
    }
    current = parent;
  }
}

/**
 * Find the VAT project root.
 *
 * Discovery ladder (checks startDir itself first, then each ancestor):
 *   1. Directory containing vibe-agent-toolkit.config.yaml → that directory
 *   2. Directory containing .git/                          → that directory
 *   3. null
 *
 * The config-anchored ladder runs to completion first; only if no config is
 * found anywhere up the tree do we walk a second time looking for .git/.
 * This implements the "config wins over git, regardless of relative depth"
 * semantic from spec §4 (config-file placement is a stronger declaration of
 * intent than the git boundary).
 *
 * Cached at the module level via {@link walkUpCache}. The cache is keyed by
 * each walked directory; entries are written for every dir touched on the
 * walk so subsequent calls from siblings/descendants become Layer-1 hits.
 *
 * @param startDir - Directory to start the walk from
 * @returns Project root directory, or null if neither config nor git root found
 */
export function findProjectRoot(startDir: string): string | null {
  const visited: string[] = [];
  const configPhase = configWalkPhase(startDir, visited);
  if (configPhase.kind === 'found') return configPhase.configRoot;
  return gitWalkPhase(startDir, visited);
}

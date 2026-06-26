/**
 * Files config merge logic, link matching, and deferred path computation.
 *
 * Handles the `files` key in skill packaging config:
 * - Merging defaults + per-skill entries (additive, per-skill wins on dest collision)
 * - Matching auto-discovered links to files entries
 * - Computing deferred paths for validation
 */

import type { SkillFileEntry } from '@vibe-agent-toolkit/resources';
import { toForwardSlash, safePath } from '@vibe-agent-toolkit/utils';

export type { SkillFileEntry } from '@vibe-agent-toolkit/resources';

/** Result of matching a link target against files config */
export interface FilesMatchResult {
  /** Whether the link matched source or dest */
  match: 'source' | 'dest';
  /** The matching files entry */
  entry: SkillFileEntry;
}

/**
 * Normalize a path for comparison: strip leading ./ and normalize slashes.
 */
function normalizePath(p: string): string {
  let normalized = toForwardSlash(p);
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/**
 * Merge defaults and per-skill files entries.
 *
 * Per-skill entries are additive to defaults. When a per-skill entry has the
 * same dest as a default, the per-skill entry wins (override by dest).
 *
 * @throws Error if duplicate dest values exist within the same level (defaults or per-skill)
 */
export function mergeFilesConfig(
  defaults: SkillFileEntry[] | undefined,
  perSkill: SkillFileEntry[] | undefined,
): SkillFileEntry[] {
  // Check for duplicates within per-skill
  if (perSkill) {
    const destSet = new Set<string>();
    for (const entry of perSkill) {
      const normalized = normalizePath(entry.dest);
      if (destSet.has(normalized)) {
        throw new Error(
          `Duplicate dest in per-skill files config: '${entry.dest}'. ` +
          `Each dest must be unique within a skill's files configuration.`
        );
      }
      destSet.add(normalized);
    }
  }

  if (!defaults?.length && !perSkill?.length) {
    return [];
  }
  if (!defaults?.length) {
    return perSkill ?? [];
  }
  if (!perSkill?.length) {
    return [...defaults];
  }

  // Build a map of dest → entry from per-skill (these win)
  const perSkillByDest = new Map<string, SkillFileEntry>();
  for (const entry of perSkill) {
    perSkillByDest.set(normalizePath(entry.dest), entry);
  }

  // Start with defaults that aren't overridden
  const merged: SkillFileEntry[] = [];
  for (const defaultEntry of defaults) {
    const normalizedDest = normalizePath(defaultEntry.dest);
    if (!perSkillByDest.has(normalizedDest)) {
      merged.push(defaultEntry);
    }
  }

  // Add all per-skill entries
  merged.push(...perSkill);

  return merged;
}

/**
 * Match a link target path against files config entries.
 *
 * Returns the matching entry and whether it matched on source or dest.
 * Source matches take priority over dest matches.
 *
 * @param linkTarget - Resolved link target path (relative to project root)
 * @param files - Merged files config entries
 * @returns Match result or null if no match
 */
export function matchLinkToFiles(
  linkTarget: string,
  files: SkillFileEntry[],
): FilesMatchResult | null {
  const normalized = normalizePath(linkTarget);

  // Source match has priority
  for (const entry of files) {
    if (normalizePath(entry.source) === normalized) {
      return { match: 'source', entry };
    }
  }

  // Then check dest match
  for (const entry of files) {
    if (normalizePath(entry.dest) === normalized) {
      return { match: 'dest', entry };
    }
  }

  return null;
}

/**
 * Structured deferred path sets returned by {@link computeDeferredPaths}.
 *
 * - `destPaths` — files: dest paths that are always deferred (the target
 *   location won't exist until build time).
 * - `sourcePaths` — files: source paths that are deferred ONLY when the
 *   target does not yet exist on disk (i.e. genuine build artifacts). A
 *   source that already exists on disk and is gitignored is a leak and must
 *   NOT be deferred — let it fall through to the gitignore branch.
 */
export interface DeferredPaths {
  /** files: dest paths — always deferred (won't exist until build). */
  destPaths: Set<string>;
  /** files: source paths — deferred ONLY when the target does not yet exist (build artifact). */
  sourcePaths: Set<string>;
}

/**
 * Options for {@link computeDeferredPaths}.
 *
 * - `skillDir`    — absolute path to the directory containing SKILL.md.
 *                   `files:` dest values are authored relative to this dir.
 * - `projectRoot` — absolute path to the project root (git / config root).
 *                   `files:` source values are authored relative to this dir.
 */
export interface ComputeDeferredPathsOpts {
  skillDir: string;
  projectRoot: string;
}

/**
 * Compute the structured sets of paths that should be treated as "deferred"
 * during source-time validation. These are paths from files config entries
 * where the file may not exist yet (build artifacts).
 *
 * Both sets contain **project-root-relative, forward-slash** paths so they
 * match the `rel` value computed in `checkDeferred()` inside walk-link-graph:
 *
 * ```ts
 * const rel = toForwardSlash(safePath.relative(projectRoot, targetPath));
 * ```
 *
 * - `dest` is authored relative to `skillDir` (mirroring `skill-packager.ts`
 *   `resolve(skillDir, entry.dest)`). We resolve it to an absolute path and
 *   then make it relative to `projectRoot`.
 * - `source` is authored relative to `projectRoot`. We resolve it with the
 *   exact expression `skill-packager.ts` uses —
 *   `resolve(join(projectRoot, entry.source))` — so an absolute-looking source
 *   is rooted UNDER `projectRoot` identically to what the packager copies.
 *   (A bare `resolve(projectRoot, source)` would let a leading slash escape the
 *   root, yielding a `../`-prefixed path that never matches the walker's `rel`.)
 *   Resolving then re-relativising is a no-op for clean relative paths but
 *   correctly strips any leading `./`.
 *
 * - dest paths are always deferred (target won't exist until build)
 * - source paths are deferred only when the target does not yet exist on disk
 */
export function computeDeferredPaths(
  files: SkillFileEntry[],
  opts: ComputeDeferredPathsOpts,
): DeferredPaths {
  const destPaths = new Set<string>();
  const sourcePaths = new Set<string>();
  for (const entry of files) {
    // dest is authored relative to skillDir (skill-packager: resolve(skillDir, dest))
    destPaths.add(
      toForwardSlash(safePath.relative(opts.projectRoot, safePath.resolve(opts.skillDir, entry.dest))),
    );
    // source is authored relative to projectRoot. Mirror skill-packager exactly:
    // resolve(join(projectRoot, source)) so absolute-looking sources root under
    // projectRoot rather than escaping it.
    sourcePaths.add(
      toForwardSlash(safePath.relative(opts.projectRoot, safePath.resolve(safePath.join(opts.projectRoot, entry.source)))),
    );
  }
  return { destPaths, sourcePaths };
}

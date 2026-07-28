/**
 * Deferred `files:` artifact model.
 *
 * A skill's `files:` config declares source→dest copies that a build step
 * materializes later — the source (a build artifact) or the dest (the
 * skill-relative copy target) may not exist yet at validation time. This
 * module computes the project-root-relative path sets those entries imply
 * and exposes a pure predicate — {@link DeferredArtifacts.covers} — so any
 * layer that needs to ask "is this path a declared-but-not-yet-materialized
 * build artifact?" can do so without executing a glob or touching the
 * filesystem.
 *
 * Lives in `resources` (not `agent-skills`) because `resources` structurally
 * cannot depend on `agent-skills`, and multiple lower-level consumers (the
 * gitignore rule, `resources validate`) need this model without pulling in
 * the whole skill-packaging package.
 */

import { isGlob, safePath, staticGlobBase, toForwardSlash } from '@vibe-agent-toolkit/utils';

import type { SkillFileEntry } from './schemas/project-config.js';

/** One skill's `files:` entries plus the dir its `dest` values are authored against. */
export interface DeferredSkillFiles {
  files: readonly SkillFileEntry[];
  /** Absolute path to the dir containing SKILL.md. */
  skillDir: string;
}

/**
 * Test whether `rel` is an exact member of `set` OR lies under any entry in
 * `set` as a directory-prefix child (i.e. `rel.startsWith(p + '/')`).
 *
 * This covers both single-file entries (where only exact equality ever fires)
 * and glob entries (where the registered value is the glob's static base dir
 * and real link targets are children of that dir).
 *
 * Safe for single-file entries: a path like `a/b.mjs` only prefix-matches the
 * impossible children `a/b.mjs/...`, which can never be real filesystem paths
 * — and a sibling like `a/b.mjs.bak` does NOT match, because the prefix check
 * requires the `/` separator, not a bare string prefix.
 */
function matchesDeferredPrefix(rel: string, set: ReadonlySet<string>): boolean {
  for (const p of set) {
    if (rel === p || rel.startsWith(p + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * Structured deferred path sets computed from one or more skills' `files:`
 * config, plus a pure containment predicate over them.
 *
 * Both sets contain **project-root-relative, forward-slash** paths:
 *
 * - `destPaths` — `dest` is authored relative to each skill's `skillDir`
 *   (mirroring `skill-packager.ts`'s `resolve(skillDir, entry.dest)`). Resolved
 *   to an absolute path, then made relative to `projectRoot`.
 * - `sourcePaths` — `source` is authored relative to `projectRoot`. Resolved
 *   with the exact expression `skill-packager.ts` uses —
 *   `resolve(join(projectRoot, entry.source))` — so an absolute-looking source
 *   is rooted UNDER `projectRoot` identically to what the packager copies. A
 *   bare `resolve(projectRoot, source)` would let a leading slash escape the
 *   root, yielding a `../`-prefixed path that never matches a real target's
 *   project-relative path. Resolving then re-relativising is a no-op for clean
 *   relative paths but correctly strips any leading `./`.
 *   For a glob source, the STATIC BASE (e.g. `dist/packs` for
 *   `dist/packs/**\/*`) is registered instead of the raw pattern, so prefix
 *   matching in {@link covers} can defer links under the glob's expansion tree
 *   without executing the glob at validate time.
 *
 * `covers()` is pure — no filesystem access. The existence gate (is the path
 * ACTUALLY missing on disk, i.e. genuinely deferred rather than a leaked,
 * already-materialized file) stays at each call site, since only the caller
 * knows whether it's evaluating a live filesystem or a built snapshot.
 */
export class DeferredArtifacts {
  readonly destPaths: ReadonlySet<string>;
  readonly sourcePaths: ReadonlySet<string>;
  readonly isEmpty: boolean;
  private readonly projectRoot: string;

  private constructor(destPaths: Set<string>, sourcePaths: Set<string>, projectRoot: string) {
    this.destPaths = destPaths;
    this.sourcePaths = sourcePaths;
    this.isEmpty = destPaths.size === 0 && sourcePaths.size === 0;
    this.projectRoot = projectRoot;
  }

  /** Build from any number of skills sharing one project root. */
  static from(skills: readonly DeferredSkillFiles[], projectRoot: string): DeferredArtifacts {
    const destPaths = new Set<string>();
    const sourcePaths = new Set<string>();

    for (const { files, skillDir } of skills) {
      for (const entry of files) {
        destPaths.add(
          toForwardSlash(safePath.relative(projectRoot, safePath.resolve(skillDir, entry.dest))),
        );
        const effectiveSource = isGlob(entry.source) ? staticGlobBase(entry.source) : entry.source;
        sourcePaths.add(
          toForwardSlash(
            safePath.relative(projectRoot, safePath.resolve(safePath.join(projectRoot, effectiveSource))),
          ),
        );
      }
    }

    return new DeferredArtifacts(destPaths, sourcePaths, projectRoot);
  }

  /** Pure predicate: does an ABSOLUTE path fall under any declared dest or source? */
  covers(absPath: string): boolean {
    const rel = toForwardSlash(safePath.relative(this.projectRoot, absPath));
    return matchesDeferredPrefix(rel, this.destPaths) || matchesDeferredPrefix(rel, this.sourcePaths);
  }

  /**
   * Pure predicate: does an ABSOLUTE path fall under a declared `files:` DEST
   * only (never a `source`)?
   *
   * Narrower than {@link covers} on purpose. A materialized, gitignored `files:`
   * **dest** is the normal, expected state of a build artifact (gitignored
   * `dist/` output) — the gitignore-leak rule exempts it. A `files:` **source**
   * is a real file in the author's own tree that they pointed at; if it's
   * gitignored and something links to it, that's a genuine leak signal the
   * gitignore rule must still raise. Use this predicate (not `covers`) wherever
   * an existing-and-gitignored target is being exempted from the leak rule; use
   * `covers` (dest-OR-source) wherever the question is instead "is this a
   * declared-but-not-yet-materialized build artifact" (the existence-gated
   * `checkDeferred`/`deferredArtifactIssue` callers), since an artifact that
   * hasn't been built yet is equally deferred whether it's the source or dest
   * half of the copy.
   */
  coversDest(absPath: string): boolean {
    const rel = toForwardSlash(safePath.relative(this.projectRoot, absPath));
    return matchesDeferredPrefix(rel, this.destPaths);
  }
}

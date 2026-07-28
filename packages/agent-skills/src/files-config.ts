/**
 * Files config merge logic, link matching, and deferred path computation.
 *
 * Handles the `files` key in skill packaging config:
 * - Merging defaults + per-skill entries (additive, per-skill wins on dest collision)
 * - Matching auto-discovered links to files entries
 * - Computing deferred paths for validation
 * - Copying declared build artifacts into a skill output dir (every build path)
 */

import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { SkillFileEntry } from '@vibe-agent-toolkit/resources';
import {
  fileContentHash,
  globMagicRemainder,
  hasParentTraversalSegment,
  isGlob,
  safePath,
  staticGlobBase,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { glob } from 'glob';

export type { SkillFileEntry } from '@vibe-agent-toolkit/resources';

/**
 * Returns a hint clause (with a leading space) when `source` looks like a build
 * artifact that hasn't been produced yet, otherwise returns `''`.
 *
 * Heuristic (conservative):
 * - The source path contains a `dist/`, `build/`, or `out/` path *segment* (exact
 *   segment equality, so `redistribute/data.json` does NOT match), OR
 * - The source ends in a bundle-ish extension: `.mjs`, `.cjs`, `.js`, `.bundle.*`
 */
const BUILD_SEGMENTS = new Set(['dist', 'build', 'out']);

export function buildArtifactHint(source: string): string {
  const normalized = toForwardSlash(source);
  const segments = normalized.split('/');
  const hasArtifactSegment = segments.some((seg) => BUILD_SEGMENTS.has(seg));
  const hasArtifactExtension =
    /\.(mjs|cjs|js)$/.test(normalized) || /\.bundle\.[^./]+$/.test(normalized);
  if (hasArtifactSegment || hasArtifactExtension) {
    return ' This looks like a build artifact — run your project\'s build to produce it before testing.';
  }
  return '';
}

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
 * For GLOB entries (`isGlob(entry.source)`), matching is by directory prefix:
 * - source match: link is equal to or under the glob's static base
 * - dest match: link is equal to or under entry.dest
 *
 * Single-file entries still match EXACTLY (unchanged).
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

  /** True when `candidate` equals `normalized` or is a path-prefix of it. */
  function isPrefixMatch(candidate: string): boolean {
    return normalized === candidate || normalized.startsWith(candidate + '/');
  }

  // Source match has priority (checked before dest across all entries)
  for (const entry of files) {
    if (isGlob(entry.source)) {
      const base = normalizePath(staticGlobBase(entry.source));
      if (isPrefixMatch(base)) {
        return { match: 'source', entry };
      }
    } else if (normalizePath(entry.source) === normalized) {
      return { match: 'source', entry };
    }
  }

  // Then check dest match
  for (const entry of files) {
    if (isGlob(entry.source)) {
      const destBase = normalizePath(entry.dest);
      if (isPrefixMatch(destBase)) {
        return { match: 'dest', entry };
      }
    } else if (normalizePath(entry.dest) === normalized) {
      return { match: 'dest', entry };
    }
  }

  return null;
}

/** Options for {@link applyFilesConfig}. */
export interface ApplyFilesConfigOptions {
  /** Merged `files:` entries to copy. */
  filesConfig: SkillFileEntry[];
  /** Absolute project root; each `source` resolves relative to it. */
  projectRoot: string;
  /** Absolute skill output dir; each `dest` resolves relative to it. */
  skillOutputDir: string;
  /**
   * Absolute source paths already materialized by link traversal — skipped so
   * a linked-and-copied asset isn't copied twice. Defaults to none (copy all).
   */
  bundledFiles?: string[];
}

/**
 * Verify that each (absSource, absDest) pair has byte-identical content.
 *
 * Throws with a message naming the offending dest path on any mismatch or
 * missing dest. Intended to be called after a copy operation to assert the
 * copy was faithful. Exported so it can be tested directly without running a
 * full applyFilesConfig round-trip.
 */
export function verifyFilesIntegrity(
  pairs: { absSource: string; absDest: string }[],
): void {
  for (const { absSource, absDest } of pairs) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths from validated config
    if (!existsSync(absDest)) {
      throw new Error(
        `files: integrity check failed — dest file missing: ${toForwardSlash(absDest)}`,
      );
    }
    const srcHash = fileContentHash(absSource);
    const dstHash = fileContentHash(absDest);
    if (srcHash !== dstHash) {
      throw new Error(
        `files: integrity check failed — content mismatch at dest: ${toForwardSlash(absDest)}`,
      );
    }
  }
}

/**
 * Verify that the on-disk contents of a glob entry's dest subtree EXACTLY match
 * the set of rel paths the copy step intended to write — no missing, no extra.
 *
 * Why a SET comparison and not just `verifyFilesIntegrity`'s byte check:
 * `verifyFilesIntegrity` hashes the (absSource, absDest) pairs that the SAME copy
 * code computed. If the rebase/glob-mapping logic maps a match to the WRONG dest,
 * that wrong dest rides along in the pair, so `hash(absSource) === hash(absDest)`
 * still passes and the bug slips through. Enumerating the dest subtree and
 * diffing against the expected rel set is what catches a misrouted rebase, a
 * stale leftover, or a dropped file.
 *
 * SAFETY ASSUMPTION (why this can't false-positive): a glob entry OWNS its dest
 * directory (`skillOutputDir/<entry.dest>`) and the build wipes the skill output
 * dir before copying (skill-packager.ts removes `resolvedOutput` recursively
 * before any copy). Nothing else writes into this subtree, so any EXTRA file is a
 * genuine bug, not a co-tenant. This scoping is what makes the set check safe
 * here even though a project-wide "no extra files" check would not be.
 *
 * @param destDir      Absolute path to the glob entry's dest subtree.
 * @param expectedRel  Forward-slash rel paths (relative to `destDir`) the copy
 *                     step wrote for THIS entry.
 * @param source       The entry's `source` (for error messages only).
 * @throws if the actual subtree omits an expected file or contains an extra one.
 */
export async function verifyDestSet(
  destDir: string,
  expectedRel: string[],
  source: string,
): Promise<void> {
  // dot: true to stay symmetric with the copy glob (M10) — both sides must see
  // hidden files, otherwise a dropped dot-file is invisible to integrity.
  const actual = (await glob('**/*', { cwd: destDir, nodir: true, dot: true }))
    .map((m) => toForwardSlash(m))
    .sort((a, b) => a.localeCompare(b));
  const expected = [...expectedRel].sort((a, b) => a.localeCompare(b));

  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  for (const rel of actual) {
    if (!expectedSet.has(rel)) {
      throw new Error(
        `files: integrity check for '${source}' found unexpected file '${rel}' under dest '${toForwardSlash(destDir)}'`,
      );
    }
  }
  for (const rel of expected) {
    if (!actualSet.has(rel)) {
      throw new Error(
        `files: integrity check for '${source}' missing expected file '${rel}' under dest '${toForwardSlash(destDir)}'`,
      );
    }
  }
}

/**
 * Copy a single (non-glob) files entry into the skill output dir.
 *
 * Returns `[destPath]` (the single entry.dest string) on success.
 * Throws on missing source or if source is a directory.
 */
async function copyNonGlobEntry(
  entry: SkillFileEntry,
  absoluteSource: string,
  skillOutputDir: string,
): Promise<{ relDest: string; absSource: string; absDest: string }> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- source path from validated config
  if (!existsSync(absoluteSource)) {
    throw new Error(
      `files: source '${entry.source}' does not exist (resolved to ${absoluteSource}).${buildArtifactHint(entry.source)}`,
    );
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- source path from validated config
  if (statSync(absoluteSource).isDirectory()) {
    throw new Error(
      `files: source '${entry.source}' is a directory; use a glob like '${entry.source}/**/*' to copy its contents.`,
    );
  }
  // joinUnderRoot rejects a dest that escapes the skill output dir (absolute /
  // drive-letter / '..'), defense-in-depth beyond the schema refine.
  const absoluteDest = safePath.joinUnderRoot(skillOutputDir, entry.dest);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dest path from validated config
  await mkdir(dirname(absoluteDest), { recursive: true });
  await copyFile(absoluteSource, absoluteDest);
  return { relDest: entry.dest, absSource: absoluteSource, absDest: absoluteDest };
}

/**
 * Expand a glob entry, copy all matched files, and return copied rel-dest paths
 * plus source/dest pairs for optional integrity verification.
 */
async function copyGlobEntry(
  entry: SkillFileEntry,
  projectRoot: string,
  skillOutputDir: string,
  bundledFileSet: Set<string>,
): Promise<{ copied: string[]; pairs: { absSource: string; absDest: string }[]; rels: string[] }> {
  const base = staticGlobBase(entry.source);
  const remainder = globMagicRemainder(entry.source);
  // H2: the static base may legitimately contain leading '..' (the deliberate
  // sibling-base monorepo feature), but the MAGIC REMAINDER must never contain a
  // '..' segment — `glob` honors it and climbs above absoluteBase. Reject it.
  if (hasParentTraversalSegment(remainder)) {
    throw new Error(
      `files: source '${entry.source}' (glob) has a '..' segment in its glob portion ('${remainder}'); ` +
      `parent-directory traversal is not allowed after the static base.`,
    );
  }
  const absoluteBase = safePath.resolve(safePath.join(projectRoot, base));

  // dot: true so hidden files under the source subtree are included — keeps the
  // package symmetric with verifyDestSet (M10: silent dot-file drop).
  const rawMatches = await glob(remainder, { cwd: absoluteBase, nodir: true, dot: true });
  const matches = rawMatches.map((m) => toForwardSlash(m)).sort((a, b) => a.localeCompare(b));

  if (matches.length === 0) {
    throw new Error(
      `files: source '${entry.source}' (glob) matched no files under ${absoluteBase} — has your build run?`,
    );
  }

  const copied: string[] = [];
  const pairs: { absSource: string; absDest: string }[] = [];
  // rels are dest-subtree-relative (relative to skillOutputDir/<entry.dest>),
  // which equals the matched `rel` for files actually copied — the expected set
  // verifyDestSet diffs the on-disk subtree against.
  const rels: string[] = [];

  for (const rel of matches) {
    // joinUnderRoot asserts each matched file stays under absoluteBase (read) and
    // that the rebased dest stays under the skill output dir (write) — H1/H2
    // defense-in-depth against a traversal that slipped past earlier guards.
    const absSource = safePath.joinUnderRoot(absoluteBase, rel);
    if (bundledFileSet.has(toForwardSlash(absSource))) continue;

    const relDest = toForwardSlash(safePath.join(entry.dest, rel));
    const absDest = safePath.joinUnderRoot(skillOutputDir, entry.dest, rel);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dest path from validated config
    await mkdir(dirname(absDest), { recursive: true });
    await copyFile(absSource, absDest);

    copied.push(relDest);
    pairs.push({ absSource, absDest });
    rels.push(toForwardSlash(rel));
  }

  return { copied, pairs, rels };
}

/**
 * Copy each `files:` entry's `source` → `dest` into the skill output directory.
 *
 * This is the single copy primitive shared by every build path so that
 * build-provided artifacts (a bundled engine, generated data, a catalog) are
 * VAT-managed end-to-end: the shared-pool `vat skills build` packager and the
 * Claude plugin marketplace build both call it, instead of the latter relying on
 * an external inject script VAT can't see. `source` is resolved the same way the
 * packager does (`resolve(join(projectRoot, source))`, so an absolute-looking
 * source roots UNDER the project). Returns the dest paths actually copied.
 *
 * Glob entries (`source` containing `*`, `?`, or `[`) expand late-bound at
 * copy time: all matched files are rebased under `dest` preserving their
 * path relative to the glob's static base. Zero matches → error.
 *
 * When `integrity: true` is set on an entry, `verifyFilesIntegrity` is called
 * after copying to assert byte-identical content. For GLOB entries it ALSO runs
 * `verifyDestSet` to assert the dest subtree contains exactly the copied rels
 * (no missing, no extra) — catching a misrouted rebase the byte check misses.
 * Single-file entries get only the byte check (dest is a file, not a subtree).
 *
 * @throws if a declared `source` does not exist — a declared build artifact must
 * be present at copy time (callers that defer existence validate it upstream).
 */
/** Copy + optionally integrity-check one GLOB `files:` entry; returns the copied rel-dests. */
async function applyGlobFileEntry(
  fileEntry: SkillFileEntry,
  opts: ApplyFilesConfigOptions,
  bundledFileSet: Set<string>,
): Promise<string[]> {
  const { copied, pairs, rels } = await copyGlobEntry(
    fileEntry,
    opts.projectRoot,
    opts.skillOutputDir,
    bundledFileSet,
  );
  if (fileEntry.integrity === true) {
    verifyFilesIntegrity(pairs);
    // Scoped set check: the glob entry owns its dest subtree and the build wiped
    // the output dir first, so the on-disk subtree must equal exactly the rels we
    // copied — catches a misrouted rebase the pair-hash misses.
    await verifyDestSet(safePath.joinUnderRoot(opts.skillOutputDir, fileEntry.dest), rels, fileEntry.source);
  }
  return copied;
}

/** Copy + optionally integrity-check one NON-GLOB `files:` entry; returns the copied rel-dests. */
async function applyNonGlobFileEntry(
  fileEntry: SkillFileEntry,
  opts: ApplyFilesConfigOptions,
  bundledFileSet: Set<string>,
): Promise<string[]> {
  const absoluteSource = safePath.resolve(safePath.join(opts.projectRoot, fileEntry.source));
  if (bundledFileSet.has(toForwardSlash(absoluteSource))) {
    // Already materialized by link traversal (copied to entry.dest via the path
    // map) — don't copy it a second time. But a requested `integrity` check must
    // NOT be silently skipped just because the copy was: verify the link-bundled
    // dest is byte-identical to the source, exactly as the copy path below would.
    // (The bundled copy lands at entry.dest — see applyNonGlobEntriesToPathMap in
    // skill-packager.ts.)
    if (fileEntry.integrity === true) {
      const absDest = safePath.joinUnderRoot(opts.skillOutputDir, fileEntry.dest);
      verifyFilesIntegrity([{ absSource: absoluteSource, absDest }]);
    }
    return [];
  }

  const { relDest, absSource, absDest } = await copyNonGlobEntry(fileEntry, absoluteSource, opts.skillOutputDir);
  if (fileEntry.integrity === true) {
    verifyFilesIntegrity([{ absSource, absDest }]);
  }
  return [relDest];
}

export async function applyFilesConfig(opts: ApplyFilesConfigOptions): Promise<string[]> {
  const bundledFileSet = new Set((opts.bundledFiles ?? []).map((f) => toForwardSlash(f)));
  const copied: string[] = [];

  for (const fileEntry of opts.filesConfig) {
    const entryCopied = isGlob(fileEntry.source)
      ? await applyGlobFileEntry(fileEntry, opts, bundledFileSet)
      : await applyNonGlobFileEntry(fileEntry, opts, bundledFileSet);
    copied.push(...entryCopied);
  }

  return copied;
}

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
import { type ValidationIssue } from '@vibe-agent-toolkit/schema';
import {
  fileContentHash,
  globMagicRemainder,
  hasParentTraversalSegment,
  isGlob,
  issueLocation,
  safePath,
  staticGlobBase,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { glob } from 'glob';
import picomatch from 'picomatch';

import { materializeIssue } from './validators/rule-engine/index.js';
import { isNeverPackagedBasename } from './validators/validation-rules.js';

export type { SkillFileEntry } from '@vibe-agent-toolkit/resources';

/**
 * Partition a glob's matches into the files that may be packaged and the
 * never-packaged ones it happened to catch.
 *
 * Only globs come through here. Naming `source: extras/README.md` explicitly is an
 * unambiguous instruction to ship that file, and it is honored; a glob is a net,
 * not a declaration, so it does not get to launder the exemption that an explicit
 * declaration earns. Without this split, link-following (which already refuses
 * these files) and `files:` expansion disagree about what belongs in a bundle —
 * and the glob's copy wins silently.
 */
function partitionNeverPackaged(matches: readonly string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const rel of matches) {
    const basename = rel.slice(rel.lastIndexOf('/') + 1);
    // THE shared matcher, not a local `Set.has` — a raw set is case-sensitive, and
    // `Claude.md` satisfies Claude Code's project-local lookup exactly as
    // `CLAUDE.md` does on APFS/NTFS, so a case-sensitive check leaves the harm
    // reachable by renaming one letter.
    (isNeverPackagedBasename(basename) ? dropped : kept).push(rel);
  }
  return { kept, dropped };
}

/** One file a GLOB `files:` entry matched and the never-package list refused. */
export interface DroppedGlobMatch {
  /** The glob `source:` whose net caught it. */
  source: string;
  /**
   * ABSOLUTE path of the refused file, forward-slashed.
   *
   * The reported subject: this is the one path in this record a reader can
   * actually open. `dest` names a path that, by definition, does NOT exist —
   * nothing was written there — so a finding anchored at the dest cannot be
   * traced back to anything. Kept absolute rather than pre-relativized because
   * the run's anchor is the caller's to choose (`locationRoot` may not be the
   * project root when one run spans several projects); every emitter passes it
   * through {@link issueLocation} at emit time.
   */
  absFile: string;
  /**
   * Skill-output-relative dest the file WOULD have had, spelled exactly as a
   * COPIED dest is (see {@link normalizeRelPath}) so consumers can compare the
   * two populations without re-deriving either. `checkBrokenPackagedLinks` keys
   * its never-package remediation on this exact set: a link is "broken because
   * VAT refused to package it" only when its target is one of THESE paths.
   *
   * A SET KEY, not a location: it is the coordinate system the packaged link
   * graph is expressed in, and mixing it into an issue's `location` — which is
   * always a source path to open — is what made one issue list speak two
   * coordinate systems at once.
   */
  dest: string;
}

/** What {@link applyFilesConfig} accounted for, and what it deliberately did not. */
export interface AppliedFilesConfig {
  /**
   * Every skill-output-relative dest this config accounts for, one per FILE
   * (glob entries expanded). See {@link applyFilesConfig} for why the orphan
   * check must be told this list.
   */
  dests: string[];
  /**
   * Files a GLOB matched that the never-package list dropped.
   *
   * Returned rather than written to a `warn` sink because a file vanishing from
   * a bundle is a build FINDING, not a log line: it has to reach the structured
   * report (`issueCounts`), or a CI consumer reads `warnings: 0` for a build
   * that silently shipped less than the config asked for.
   */
  dropped: DroppedGlobMatch[];
}

/**
 * Turn never-package drops into reportable findings.
 *
 * Lives here rather than in the packager because this module owns the concept:
 * the drop and the issue describing it must not be able to disagree.
 *
 * Anchored at the SOURCE file, in ONE coordinate system for both the location
 * and the message. The finding used to name the would-be `dest` in both, which
 * meant the only path it gave you was an output path nothing was ever written to
 * — so the issue list mixed output coordinates (this code) with source
 * coordinates (every other pre-build code) and an adopter could not open the
 * thing that went missing. The glob pattern stays in the message because it
 * answers the second question ("which entry caught this?"), but it is no longer
 * the only identifiable thing in the finding.
 *
 * @param locationRoot The ONE base this run anchors locations at. Required, not
 *   defaulted to the project root: a defaulted anchor is how a multi-project run
 *   silently emits paths relative to the wrong tree.
 */
export function droppedGlobMatchesToIssues(
  dropped: readonly DroppedGlobMatch[],
  locationRoot: string,
): ValidationIssue[] {
  return dropped.map((drop) => {
    const file = issueLocation(drop.absFile, locationRoot);
    return materializeIssue('FILES_GLOB_DROPPED_NEVER_PACKAGED', {
      location: file,
      detail: `${file} matched by files: source '${drop.source}'`,
    });
  });
}

/**
 * An absolute path spelled relative to the run's anchor, for a message or a
 * location a consumer reads.
 *
 * `issueLocation` returns `''` when the path IS the anchor root (a
 * project-root-wide glob such as `**\/*`); `.` is that same directory spelled
 * as a path a reader can act on.
 *
 * Load-bearing for every THROWN message in this module, not only for issue
 * locations: `applyFilesConfig`'s throws reach `vat skills build`'s stdout
 * verbatim as `failedSkills[].message`, so an absolute path there publishes the
 * developer's home directory into whatever issue or CI log the report is pasted
 * into. Build-report messages are project-relative, never absolute.
 */
function anchoredPath(absolute: string, root: string): string {
  return issueLocation(absolute, root) || '.';
}

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

/**
 * Normalize a relative path for comparison: forward slashes, no leading `./`.
 * The path's ROOT is the caller's business; this only fixes the spelling.
 *
 * Exported because it is the spelling every `files:` dest returned by
 * {@link applyFilesConfig} is normalized to, and that spelling must equal the one
 * `checkUnreferencedFiles` computes for a packaged file
 * (`toForwardSlash(safePath.relative(outputDir, file))`) — both are
 * skill-output-relative. A silent mismatch there reads as "not declared in
 * `files:` config" about a copy VAT performed itself.
 */
export function normalizeRelPath(p: string): string {
  let normalized = toForwardSlash(p);
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/**
 * The skill-output-relative dest a GLOB `files:` entry gives one absolute source
 * path, or `undefined` when the entry's expansion would not include it.
 *
 * Answers, without running the glob, the question the packager must settle BEFORE
 * anything is copied: "does the config already declare where this file goes?" A
 * glob's expansion is late-bound to copy time ({@link copyGlobEntry}), so the path
 * map used to have no entry for its matches — and a match that link traversal ALSO
 * found was therefore dropped at its type-derived location while the glob copied
 * it to the declared dest. Identical bytes shipped twice, the rewritten link
 * pointed at traversal's copy, and the declared `dest:` was dead. One file, one
 * dest: the declaration wins, and this is how the path map learns it.
 *
 * The three gates below are exactly {@link copyGlobEntry}'s own, restated as a
 * predicate so the dest computed here is the dest the copy actually writes:
 * under the static base, matching the magic remainder (`dot: true`, as the copy
 * expands), and not refused by {@link partitionNeverPackaged}. A never-packaged
 * match has NO dest — re-pointing the path map at one would rewrite a link to a
 * file that never arrives.
 */
export function globEntryDest(
  entry: SkillFileEntry,
  projectRoot: string,
  absSource: string,
): string | undefined {
  if (!isGlob(entry.source)) return undefined;

  const absoluteBase = toForwardSlash(
    safePath.resolve(safePath.join(projectRoot, staticGlobBase(entry.source))),
  );
  const abs = toForwardSlash(safePath.resolve(absSource));
  if (!abs.startsWith(absoluteBase + '/')) return undefined;

  const rel = abs.slice(absoluteBase.length + 1);
  if (!picomatch.isMatch(rel, globMagicRemainder(entry.source), { dot: true })) return undefined;
  if (isNeverPackagedBasename(rel.slice(rel.lastIndexOf('/') + 1))) return undefined;

  return normalizeRelPath(safePath.join(entry.dest, rel));
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
      const normalized = normalizeRelPath(entry.dest);
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
    perSkillByDest.set(normalizeRelPath(entry.dest), entry);
  }

  // Start with defaults that aren't overridden
  const merged: SkillFileEntry[] = [];
  for (const defaultEntry of defaults) {
    const normalizedDest = normalizeRelPath(defaultEntry.dest);
    if (!perSkillByDest.has(normalizedDest)) {
      merged.push(defaultEntry);
    }
  }

  // Add all per-skill entries
  merged.push(...perSkill);

  return merged;
}

/**
 * The skill-output-relative dests named by EXPLICIT (non-glob) `files:` entries.
 *
 * THE definition of "the config declared this output path", shared by every lane
 * that has to decide whether a file in a bundle is there on purpose. Naming a
 * `source`/`dest` pair is an unambiguous instruction to ship that file; a GLOB
 * never named the file it caught, so its expansion is deliberately absent from
 * this list — a net is not a declaration. (`walk-link-graph.ts`'s
 * `refusesAgentInstructionFile` draws the same line on the link side, and
 * {@link partitionNeverPackaged} on the copy side; all three must agree or the
 * mechanisms disagree about one bundle.)
 *
 * Spelled via {@link normalizeRelPath}, which is the spelling a packaged file's
 * output-relative path is computed with — so membership can be tested by exact
 * equality, never by a prefix test.
 */
export function explicitFilesConfigDests(files: readonly SkillFileEntry[]): string[] {
  return files.filter((entry) => !isGlob(entry.source)).map((entry) => normalizeRelPath(entry.dest));
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
   * Absolute source paths already materialized by link traversal.
   *
   * Used only by NON-GLOB entries, where the packager's path map guarantees the
   * bundled copy already sits at `entry.dest`, so re-copying is pure duplication.
   * Glob entries carry no such guarantee and copy unconditionally — see
   * {@link copyGlobEntry}. Defaults to none (copy all).
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
 * SAFETY ASSUMPTION (why this can't false-positive): a glob entry does NOT own
 * its dest directory outright — another `files:` entry may legitimately declare a
 * dest inside the same subtree, and that is exactly how the documented escape
 * hatch works (an explicit `source: extras/README.md` re-ships a file the glob
 * refused). So `expectedRel` is the union of what THIS entry copied and every
 * other entry's declared dest under the same subtree, and the caller runs this
 * only after ALL entries have copied — see {@link applyFilesConfig}. What is left
 * over is a file no entry accounts for: a genuine bug, not a co-tenant. (The build
 * wipes the skill output dir before copying — skill-packager.ts removes
 * `resolvedOutput` recursively — so there are no stale files either.)
 *
 * @param destDir      Absolute path to the glob entry's dest subtree.
 * @param expectedRel  Forward-slash rel paths (relative to `destDir`) that the
 *                     whole `files:` config accounts for inside this subtree.
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
  projectRoot: string,
  skillOutputDir: string,
): Promise<{ relDest: string; absSource: string; absDest: string }> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- source path from validated config
  if (!existsSync(absoluteSource)) {
    throw new Error(
      `files: source '${entry.source}' does not exist (resolved to ${anchoredPath(absoluteSource, projectRoot)}).${buildArtifactHint(entry.source)}`,
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
  return { relDest: normalizeRelPath(entry.dest), absSource: absoluteSource, absDest: absoluteDest };
}

/** What expanding one GLOB `files:` entry against the project tree yielded. */
interface GlobExpansion {
  /** Absolute path of the glob's static base (used in the copy's error messages). */
  absoluteBase: string;
  /** Every match, base-relative, BEFORE the never-package filter. */
  allMatches: string[];
  /** Matches that may be packaged, base-relative (the copy's work list). */
  kept: string[];
  /**
   * Matches the never-package list refused, BASE-relative — the coordinate the
   * author wrote the glob in. Used only by the copy's error message, which is
   * about the pattern, not about an output that was never written.
   */
  droppedRel: string[];
  /**
   * The same refusals spelled as their would-be DESTS. Every reporting consumer
   * wants this one: they ask "is the file this link points AT one VAT refused to
   * package?", and that is only answerable in output-relative coordinates.
   */
  dropped: DroppedGlobMatch[];
}

/**
 * THE expansion of one GLOB `files:` entry — the single answer to "which files does
 * this pattern name, and which of them never ship?".
 *
 * Extracted so the copy ({@link copyGlobEntry}) and the pre-build gates
 * ({@link collectDroppedGlobMatches}) cannot expand the same glob two ways. A
 * second expansion that disagrees with the copy's is exactly how a lane comes to
 * report a bundle that was never produced.
 *
 * Deliberately reports NO verdict: zero matches is a fact here, and only the caller
 * knows whether it is a failure (the copy, after a build) or the expected state (a
 * validate run before one).
 *
 * @throws if the glob's magic remainder contains a `..` segment — `glob` honors it
 *   and climbs above `absoluteBase`, so the pattern cannot be expanded safely at
 *   any phase. (The static base may legitimately contain a leading `..`: that is
 *   the deliberate sibling-base monorepo feature.)
 */
async function expandGlobEntry(
  entry: SkillFileEntry,
  projectRoot: string,
): Promise<GlobExpansion> {
  const remainder = globMagicRemainder(entry.source);
  if (hasParentTraversalSegment(remainder)) {
    throw new Error(
      `files: source '${entry.source}' (glob) has a '..' segment in its glob portion ('${remainder}'); ` +
      `parent-directory traversal is not allowed after the static base.`,
    );
  }
  const absoluteBase = safePath.resolve(safePath.join(projectRoot, staticGlobBase(entry.source)));

  // dot: true so hidden files under the source subtree are included — keeps the
  // package symmetric with verifyDestSet (M10: silent dot-file drop).
  const rawMatches = await glob(remainder, { cwd: absoluteBase, nodir: true, dot: true });
  const allMatches = rawMatches.map((m) => toForwardSlash(m)).sort((a, b) => a.localeCompare(b));

  const { kept, dropped } = partitionNeverPackaged(allMatches);

  return {
    absoluteBase,
    allMatches,
    kept,
    droppedRel: dropped,
    dropped: dropped.map((rel) => ({
      source: entry.source,
      // The refused file itself. Computed HERE, where the base a match is
      // relative to is known for certain, rather than re-derived by each
      // consumer from `dest` — a dest cannot be inverted back to a source once
      // the entry has rebased it.
      absFile: toForwardSlash(safePath.joinUnderRoot(absoluteBase, rel)),
      dest: normalizeRelPath(safePath.join(entry.dest, rel)),
    })),
  };
}

/**
 * Expand a glob entry, copy all matched files, and return copied rel-dest paths
 * plus source/dest pairs for optional integrity verification.
 *
 * There is deliberately NO bundled-file skip here, unlike {@link applyNonGlobFileEntry}.
 * Both spellings obey one invariant — *after this function runs, every file the
 * entry matches exists at its declared dest and is reported* — but only the
 * non-glob path can satisfy it by skipping: `applyNonGlobEntriesToPathMap`
 * (skill-packager.ts) re-points the path map so link traversal's copy lands AT
 * `entry.dest`, making the skip a pure de-duplication. Glob entries are
 * deliberately absent from that path map (late binding owns their expansion), so
 * traversal drops a link-bundled match at its own resource-named location instead.
 * Skipping the copy here would leave the declared dest subtree short a declared
 * file — silently, and with `integrity: true` silently defeated too, because the
 * skipped file lands in neither `rels` nor the on-disk subtree `verifyDestSet`
 * diffs against. Copying it unconditionally keeps `copied`, `pairs`, and `rels`
 * complete and makes integrity mean what it says.
 */
async function copyGlobEntry(
  entry: SkillFileEntry,
  projectRoot: string,
  skillOutputDir: string,
): Promise<{
  copied: string[];
  pairs: { absSource: string; absDest: string }[];
  rels: string[];
  dropped: DroppedGlobMatch[];
}> {
  const { absoluteBase, allMatches, kept: matches, droppedRel, dropped } = await expandGlobEntry(
    entry,
    projectRoot,
  );

  // Project-relative in both throws below: these messages are published verbatim
  // as `failedSkills[].message` (see {@link anchoredPath}).
  const reportedBase = anchoredPath(absoluteBase, projectRoot);

  if (allMatches.length === 0) {
    throw new Error(
      `files: source '${entry.source}' (glob) matched no files under ${reportedBase} — has your build run?`,
    );
  }

  // Distinct from the zero-match case above: the build DID run and the glob DID
  // match — every match is simply a file that never ships. Saying "has your build
  // run?" here would send the author hunting a build failure that isn't there.
  if (matches.length === 0) {
    throw new Error(
      `files: source '${entry.source}' (glob) matched ${allMatches.length} file(s) under ${reportedBase}, ` +
      `but all of them are never packaged into a skill bundle: ${droppedRel.join(', ')}. ` +
      // NOT "widen the glob": the filter is on basename and applies at any width, so a
      // wider glob clears this error while still shipping none of these files — advice
      // that looks like it worked and silently does not.
      `Declare an explicit source: entry for a file you intend to ship, ` +
      `or point the glob at a directory that holds files which can be packaged.`,
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
    const relDest = normalizeRelPath(safePath.join(entry.dest, rel));
    const absDest = safePath.joinUnderRoot(skillOutputDir, entry.dest, rel);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dest path from validated config
    await mkdir(dirname(absDest), { recursive: true });
    await copyFile(absSource, absDest);

    copied.push(relDest);
    pairs.push({ absSource, absDest });
    rels.push(toForwardSlash(rel));
  }

  return { copied, pairs, rels, dropped };
}

/** One GLOB `files:` entry that currently expands to nothing at all. */
export interface UnmatchedGlobEntry {
  /** The glob `source:` that matched no files. */
  source: string;
  /**
   * ABSOLUTE path of the directory it expanded under (the glob's static base),
   * forward-slashed. Absolute for the same reason as
   * {@link DroppedGlobMatch.absFile}: the run's anchor is the emitter's choice.
   * The directory need not exist — "it isn't there yet" is the common case.
   */
  absBase: string;
}

/** One GLOB `files:` entry whose every match the never-package list refused. */
export interface AllRefusedGlobEntry {
  /** The glob `source:` that netted only never-packaged files. */
  source: string;
  /** ABSOLUTE path of the directory it expanded under, forward-slashed. */
  absBase: string;
  /**
   * ABSOLUTE paths of every match, all of them refused. Carried in full because
   * this finding SUPERSEDES the per-file drops for its entry (see
   * {@link collectPreBuildGlobFindings}), so it is the only place those file
   * names are still reported.
   */
  absRefused: string[];
}

/**
 * What the project's GLOB `files:` entries look like BEFORE anything is built.
 *
 * The three buckets are MUTUALLY EXCLUSIVE per entry, and they are three of the
 * FOUR verdicts `copyGlobEntry` reaches at copy time — one entry cannot be both
 * "matched nothing" and "matched only refused files", and an entry counted in
 * `allRefused` contributes no `dropped` rows. Overlapping buckets would let one
 * config produce two findings naming two different causes.
 *
 * The fourth verdict has NO bucket: a `..` segment in the glob's magic remainder
 * makes the pattern unexpandable, `expandGlobEntry` throws, and
 * {@link collectPreBuildGlobFindings} skips the entry rather than mislabelling it.
 * So a config certain to fail the build produces no pre-build finding at all —
 * see the skip in that function for why nothing here can honestly carry it.
 */
export interface PreBuildGlobFindings {
  /**
   * Never-packaged files a glob would catch while still shipping something else.
   * See {@link DroppedGlobMatch}.
   */
  dropped: DroppedGlobMatch[];
  /** Globs that matched, but whose every match was refused — they ship nothing. */
  allRefused: AllRefusedGlobEntry[];
  /** Globs that currently match nothing — the other input the build dies on. */
  unmatched: UnmatchedGlobEntry[];
}

/**
 * What the project's GLOB `files:` entries would do, without copying anything.
 *
 * The pre-build half of {@link applyFilesConfig}: `vat skills validate` and
 * `vat audit` can answer "what will this config fail to ship?" before a build
 * exists, and they answer it by running THE expansion the copy runs
 * ({@link expandGlobEntry}) — a second, independently written expansion would be
 * free to disagree with the copy about what ships, which is the whole defect class
 * this module exists to close.
 *
 * Non-throwing by construction, unlike {@link copyGlobEntry}: a pre-build gate runs
 * before the artifact exists, so a glob over an unbuilt `dist/` matching nothing is
 * the expected state, not a failure. `copyGlobEntry` still raises there, where the
 * build HAS run and zero matches is real.
 *
 * That reasoning settles the SEVERITY of a failing expansion, not whether to
 * mention it — and this used to return only `dropped`, so the gate reported the
 * drop that is harmless by design (a glob is a net) and said nothing about either
 * expansion outcome that is certain to fail the very next command. `unmatched`
 * and `allRefused` end that silence, graded `info` and `warning` respectively (see
 * FILES_GLOB_MATCHED_NOTHING / FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED).
 *
 * The three buckets partition the entries as two of `copyGlobEntry`'s three throws
 * plus its success path do — same predicates, same order, one expansion. Its THIRD
 * throw (`expandGlobEntry` refusing a `..` segment in the magic remainder) has no
 * bucket, and the skip below explains why — but the consequence belongs here: this
 * function's answer to "what will this config fail to ship?" is silent for that one
 * malformed shape, which is the same class of silence `unmatched`/`allRefused` were
 * added to end. Closing it needs a code of its own (a wrong-shaped PATTERN, not an
 * unbuilt or unshippable artifact), or a `source` refine on `SkillFileEntrySchema`
 * that rejects the pattern at config load and makes the skip unreachable.
 *
 * Drops re-shipped by an explicit entry are filtered out for the same reason
 * {@link applyFilesConfig} filters them: reporting "it did not ship" about a file
 * the documented escape hatch puts in the bundle tells an author their remediation
 * failed when it worked. That filter is deliberately NOT applied to `allRefused`:
 * `copyGlobEntry` throws on an entry whose own kept-set is empty no matter what
 * any other entry ships, so filtering it would predict a green build that fails.
 */
export async function collectPreBuildGlobFindings(
  filesConfig: readonly SkillFileEntry[],
  projectRoot: string,
): Promise<PreBuildGlobFindings> {
  const shippedDests = new Set(explicitFilesConfigDests(filesConfig));
  const dropped: DroppedGlobMatch[] = [];
  const allRefused: AllRefusedGlobEntry[] = [];
  const unmatched: UnmatchedGlobEntry[] = [];
  for (const entry of filesConfig) {
    if (!isGlob(entry.source)) continue;
    // A '..' segment in the magic remainder is a malformed pattern that
    // `expandGlobEntry` refuses to expand. It is the BUILD's error to raise (and
    // `copyGlobEntry` does); a pre-build gate asking "what would this do?" must not
    // abort the whole run over it — and it must not put the entry in either failure
    // bucket, which would name a cause (an unbuilt or unshippable artifact) that is
    // not the one.
    //
    // KNOWN GAP, stated rather than implied by a `continue`: this skip is total, so
    // the entry produces NO finding in any pre-build lane and the author first hears
    // about it from a failed build. Not "misreported", but not reported either. The
    // honest fix is a distinct code for a wrong-shaped pattern, or rejecting the
    // pattern in `SkillFileEntrySchema.source` the way `dest` already is — at which
    // point this line becomes defense-in-depth against a config that cannot load.
    if (hasParentTraversalSegment(globMagicRemainder(entry.source))) continue;
    const expansion = await expandGlobEntry(entry, projectRoot);
    const absBase = toForwardSlash(expansion.absoluteBase);
    // The two predicates below are `copyGlobEntry`'s two throws, in its order and
    // keyed on its fields: zero total matches first, then zero SURVIVING matches.
    // Keeping them distinct is what stops a wholly-refused glob from being
    // reported as an unbuilt one — the build says "has your build run?" only in
    // the first case, and sending an author to re-run a build that already ran is
    // exactly the misdirection the second error was written to avoid.
    if (expansion.allMatches.length === 0) {
      unmatched.push({ source: entry.source, absBase });
      continue;
    }
    if (expansion.kept.length === 0) {
      // Supersedes this entry's per-file drops rather than adding to them: the
      // build raises ONE error listing every refused file, and reporting the same
      // cause again at file granularity would double-count a single defect. The
      // file names are preserved on `absRefused`.
      allRefused.push({
        source: entry.source,
        absBase,
        absRefused: expansion.dropped.map((d) => d.absFile),
      });
      continue;
    }
    dropped.push(...expansion.dropped.filter((d) => !shippedDests.has(normalizeRelPath(d.dest))));
  }
  return { dropped, allRefused, unmatched };
}

/**
 * Turn {@link collectPreBuildGlobFindings} into reportable pre-build issues.
 *
 * THE emitter for the pre-build gates, so a lane cannot pick up one half of the
 * findings and quietly drop the other — which is how the zero-match went
 * unreported for as long as it did.
 *
 * @param locationRoot The ONE base this run anchors locations at (see
 *   {@link droppedGlobMatchesToIssues}).
 */
export function preBuildGlobFindingsToIssues(
  findings: PreBuildGlobFindings,
  locationRoot: string,
): ValidationIssue[] {
  // Both entry-level findings anchor at the glob's static base: they are about an
  // ENTRY, not a file, and the base is the only path they have.
  const anchorBase = (absBase: string): string => anchoredPath(absBase, locationRoot);
  return [
    ...droppedGlobMatchesToIssues(findings.dropped, locationRoot),
    ...findings.allRefused.map((entry) => {
      const base = anchorBase(entry.absBase);
      // Every refused file, in the SAME source coordinates the drop findings use —
      // this issue is the only surviving report of those names.
      const refused = entry.absRefused.map((f) => issueLocation(f, locationRoot)).join(', ');
      return materializeIssue('FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED', {
        location: base,
        detail:
          `files: source '${entry.source}' matched ${entry.absRefused.length} file(s) under ${base}, ` +
          `all never packaged: ${refused}`,
      });
    }),
    ...findings.unmatched.map((entry) => {
      const base = anchorBase(entry.absBase);
      return materializeIssue('FILES_GLOB_MATCHED_NOTHING', {
        location: base,
        detail: `files: source '${entry.source}' expands under ${base}`,
      });
    }),
  ];
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
 * source roots UNDER the project).
 *
 * Returns an {@link AppliedFilesConfig}: `dests` is every skill-output-relative
 * dest path this config accounts for, one per FILE (glob entries expanded),
 * normalized via {@link normalizeRelPath} so each value compares equal to the path
 * `checkUnreferencedFiles` computes for the packaged file. Callers must pass it to
 * the post-build orphan check: a dest declared in `files:` is proof of intent, and
 * a lane that doesn't know the list flags VAT's own copies as files the author
 * forgot to document. `dropped` is the never-packaged files a glob matched and
 * this function refused — callers must report it (see
 * {@link droppedGlobMatchesToIssues}) and pass its dests to
 * `checkBrokenPackagedLinks`, which is the only lane that can tell a link broken
 * by policy from a link broken by a rewriter bug.
 *
 * ONE invariant, both spellings: when this returns, every file the config matched
 * exists at its declared dest and is reported. A source already materialized by
 * link traversal changes nothing about that answer — it is declared either way,
 * and whether traversal or this copy put the bytes there is an ordering accident.
 * Only the mechanism differs: a non-glob entry's bundled copy already sits AT
 * `entry.dest` (the packager re-points the path map for it), so its copy is
 * skipped as redundant; a glob entry's does not, so it is copied regardless — see
 * {@link copyGlobEntry}.
 *
 * Glob entries (`source` containing `*`, `?`, or `[`) expand late-bound at
 * copy time: all matched files are rebased under `dest` preserving their
 * path relative to the glob's static base. Zero matches → error.
 *
 * A glob's matches are filtered through {@link NEVER_PACKAGE_IN_SKILL_BUNDLE}
 * (agent-instruction files at any surface, navigation files in a skill bundle);
 * an explicit entry is not. See {@link partitionNeverPackaged}.
 *
 * When `integrity: true` is set on an entry, `verifyFilesIntegrity` is called to
 * assert byte-identical content. For GLOB entries it ALSO runs `verifyDestSet` to
 * assert the dest subtree contains exactly the files the config accounts for (no
 * missing, no extra) — catching a misrouted rebase the byte check misses.
 * Single-file entries get only the byte check (dest is a file, not a subtree).
 *
 * Every integrity check runs AFTER all entries have copied, never inline. Inline,
 * the verdict depended on the ORDER entries appear in: an explicit
 * `source: extras/README.md` (the documented escape hatch for a file the glob's
 * never-package filter drops) listed BEFORE the glob made the glob's set check
 * throw `unexpected file 'README.md'`, while the same two entries in the opposite
 * order passed — and in the passing order the check ran before the explicit entry
 * had written anything, so it was no longer a statement about the shipped bundle.
 *
 * @throws if a declared `source` does not exist — a declared build artifact must
 * be present at copy time (callers that defer existence validate it upstream).
 */

/**
 * Integrity work for one entry, deferred until every entry has copied.
 * `rels` is present only for GLOB entries (a single-file dest is not a subtree).
 */
interface PendingIntegrity {
  entry: SkillFileEntry;
  pairs: { absSource: string; absDest: string }[];
  rels: string[] | undefined;
}

/** What applying ONE `files:` entry produced. */
interface EntryOutcome {
  /** Skill-output-relative dests this entry accounts for. */
  dests: string[];
  dropped: DroppedGlobMatch[];
  /** Deferred integrity work, or `undefined` when the entry did not opt in. */
  pending: PendingIntegrity | undefined;
}

/** Copy one GLOB `files:` entry. */
async function applyGlobFileEntry(
  fileEntry: SkillFileEntry,
  opts: ApplyFilesConfigOptions,
): Promise<EntryOutcome> {
  const { copied, pairs, rels, dropped } = await copyGlobEntry(
    fileEntry,
    opts.projectRoot,
    opts.skillOutputDir,
  );
  return {
    dests: copied,
    dropped,
    pending: fileEntry.integrity === true ? { entry: fileEntry, pairs, rels } : undefined,
  };
}

/**
 * Reject a NON-GLOB `dest` that names a directory rather than a file.
 *
 * A non-glob entry is a typed single-file slot: one source, one output path. A
 * `dest` ending in a separator (or spelling the dest root itself) names a
 * directory, and nothing downstream noticed — `copyFile` wrote the source's bytes
 * to a file NAMED `guides`, and the config then accounted for `guides/` while the
 * bundle held `guides`, so the two never compared equal.
 *
 * Worth its own error rather than a silent normalization because of WHAT can ride
 * in: an explicit entry is the one thing that sanctions shipping an
 * agent-instruction file, and at a directory-shaped dest that file arrives under a
 * basename no never-package rule and no presence detector recognizes. Renaming
 * `CLAUDE.md` to `guides` on the author's behalf is not a service.
 *
 * GLOB entries are deliberately exempt: their `dest` IS a subtree root, and every
 * match is joined onto it (`safePath.join('packs/', 'a/x.json')`), which drops the
 * trailing separator on its own.
 */
function assertFileShapedDest(entry: SkillFileEntry): void {
  const normalized = normalizeRelPath(entry.dest);
  if (normalized !== '' && normalized !== '.' && !normalized.endsWith('/')) return;
  let base = normalized;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const suggested = `${base}/${entry.source.slice(entry.source.lastIndexOf('/') + 1)}`;
  throw new Error(
    `files: dest '${entry.dest}' names a directory, but a non-glob entry copies ONE file to ONE path. ` +
    `Name the output file itself (e.g. dest: '${normalizeRelPath(suggested)}'), ` +
    `or use a glob source to copy a whole subtree.`,
  );
}

/** Copy one NON-GLOB `files:` entry. */
async function applyNonGlobFileEntry(
  fileEntry: SkillFileEntry,
  opts: ApplyFilesConfigOptions,
  bundledFileSet: Set<string>,
): Promise<EntryOutcome> {
  // Before the bundled-skip branch below, never inside it: which branch an entry
  // takes depends on whether link traversal happened to reach the source first,
  // and a malformed dest must not be validated by an ordering accident.
  assertFileShapedDest(fileEntry);
  const absoluteSource = safePath.resolve(safePath.join(opts.projectRoot, fileEntry.source));
  const optedIn = fileEntry.integrity === true;

  if (bundledFileSet.has(toForwardSlash(absoluteSource))) {
    // Already materialized by link traversal (copied to entry.dest via the path
    // map) — don't copy it a second time. But a requested `integrity` check must
    // NOT be silently skipped just because the copy was: verify the link-bundled
    // dest is byte-identical to the source, exactly as the copy path below would.
    // (The bundled copy lands at entry.dest — see applyNonGlobEntriesToPathMap in
    // skill-packager.ts.)
    const absDest = safePath.joinUnderRoot(opts.skillOutputDir, fileEntry.dest);
    // The dest is still reported: this function answers "which output paths does
    // `files:` account for," not "which bytes did I move." Whether link traversal
    // or this copy put the file there is an ordering accident, and callers that
    // ask "is this packaged file declared?" must not get a different answer for it.
    return {
      dests: [normalizeRelPath(fileEntry.dest)],
      dropped: [],
      pending: optedIn
        ? { entry: fileEntry, pairs: [{ absSource: absoluteSource, absDest }], rels: undefined }
        : undefined,
    };
  }

  const { relDest, absSource, absDest } = await copyNonGlobEntry(
    fileEntry,
    absoluteSource,
    opts.projectRoot,
    opts.skillOutputDir,
  );
  return {
    dests: [relDest],
    dropped: [],
    pending: optedIn ? { entry: fileEntry, pairs: [{ absSource, absDest }], rels: undefined } : undefined,
  };
}

/**
 * `dest` expressed relative to the `destRoot` subtree, or `null` when it does not
 * live inside it. Both arguments are skill-output-relative and normalized.
 *
 * Equality returns `null` on purpose: a dest EQUAL to the subtree root names the
 * directory itself, not a file inside it, so it contributes nothing to a file set.
 */
function relUnderDest(destRoot: string, dest: string): string | null {
  if (destRoot === '' || destRoot === '.') return dest;
  return dest.startsWith(destRoot + '/') ? dest.slice(destRoot.length + 1) : null;
}

/**
 * Run every opted-in integrity check once the whole config has copied.
 *
 * `allDests` is the config's complete accounting, which is what makes a glob's
 * dest-set check order-independent: a sibling entry's dest inside the same subtree
 * is EXPECTED (that is the escape hatch working), while a file no entry declares
 * is still unexpected — so this stays a real assertion about the shipped bundle
 * rather than being weakened into a permissive one.
 */
async function runDeferredIntegrity(
  pending: readonly PendingIntegrity[],
  allDests: readonly string[],
  skillOutputDir: string,
): Promise<void> {
  for (const { entry, pairs, rels } of pending) {
    verifyFilesIntegrity(pairs);
    if (rels === undefined) continue;

    const destRoot = normalizeRelPath(entry.dest);
    const expected = new Set(rels);
    for (const dest of allDests) {
      const rel = relUnderDest(destRoot, dest);
      if (rel !== null && rel !== '') expected.add(rel);
    }
    await verifyDestSet(
      safePath.joinUnderRoot(skillOutputDir, entry.dest),
      [...expected],
      entry.source,
    );
  }
}

export async function applyFilesConfig(opts: ApplyFilesConfigOptions): Promise<AppliedFilesConfig> {
  const bundledFileSet = new Set((opts.bundledFiles ?? []).map((f) => toForwardSlash(f)));
  const dests: string[] = [];
  const dropped: DroppedGlobMatch[] = [];
  const pending: PendingIntegrity[] = [];

  for (const fileEntry of opts.filesConfig) {
    const outcome = isGlob(fileEntry.source)
      ? await applyGlobFileEntry(fileEntry, opts)
      : await applyNonGlobFileEntry(fileEntry, opts, bundledFileSet);
    dests.push(...outcome.dests);
    dropped.push(...outcome.dropped);
    if (outcome.pending) pending.push(outcome.pending);
  }

  await runDeferredIntegrity(pending, dests, opts.skillOutputDir);

  // A drop is only worth reporting if the file genuinely did not ship. In the
  // escape-hatch config the guide prescribes — a glob over a subtree plus an
  // explicit entry naming one never-packaged file inside it — the glob drops
  // that dest and the explicit entry writes it. Reporting the drop there would
  // assert "it did not ship" about a file sitting in the bundle, telling an
  // author their documented remediation had failed. Filtering on the FINAL dest
  // set (not on entry order) keeps the finding true whichever order they wrote.
  const shippedDests = new Set(dests.map((d) => normalizeRelPath(d)));
  const reportableDropped = dropped.filter((d) => !shippedDests.has(normalizeRelPath(d.dest)));

  return { dests, dropped: reportableDropped };
}

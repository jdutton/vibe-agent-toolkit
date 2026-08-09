/**
 * Link validation for markdown resources.
 *
 * Validates different types of links:
 * - local_file: Checks if file exists, validates anchors if present, checks git-ignore safety
 * - anchor: Validates heading exists in current or target file
 * - external: Returns info (not validated)
 * - email: Returns null (valid by default)
 * - unknown: Returns warning
 *
 * Git-ignore safety (Phase 3):
 * - Non-ignored files cannot link to ignored files (error: link_to_gitignored)
 * - Ignored files CAN link to ignored files (no error)
 * - Ignored files CAN link to non-ignored files (no error)
 * - External resources (outside project) skip git-ignore checks
 *
 * **Two passes, not one — and the fill is not finished yet.**
 *
 * The fill pass resolves every link once ({@link resolveLinkEntries}), names the
 * local targets ({@link linkTargetPaths}) and lists their parent directories
 * concurrently (`fillSiblingNames`). The judge pass ({@link judgeLink}) is
 * synchronous and does **no directory listing and no href resolution** — both of
 * those facts travel to it, the listing in the table and the resolution on the
 * entry.
 *
 * ⚠️ **The judge is not I/O-free, and no comment in this file may claim it is.**
 * Two facts judgement needs are still unfilled, and both are read at judgement
 * time through direct imports rather than through anything the judge is handed:
 *
 * - `isWithinProject` — two `fs.realpathSync` per *existing* local target,
 *   reached from {@link gitIgnoreSafetyIssue}.
 * - `isGitIgnored` — a `spawnSync` of `git check-ignore`, reached for every
 *   existing local target whenever `skipGitIgnoreCheck !== true` and no
 *   {@link GitTracker} was supplied (a real configuration: the registry makes
 *   its tracker conditional).
 *
 * Those are the next two columns the fill should grow. Until they are filled,
 * judging a corpus does interleave I/O — just far less of it, and never a
 * `readdir`.
 *
 * {@link validateLink} is the one-shot composition for a caller with a single
 * link.
 */

import path from 'node:path';

import { createRegistryIssue, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import {
  classifyFilenameCaseFrom,
  fillSiblingNames,
  FsLookupCache,
  isGitIgnored,
  type GitTracker,
  issueLocation,
  type SiblingNamesTable,
} from '@vibe-agent-toolkit/utils';

import type { DeferredArtifacts } from './deferred-artifacts.js';
import type { ResourceLink } from './types.js';
import {
  isWithinProject,
  locationRoot,
  resolveLocalHref,
  type ResolveLocalHrefResult,
} from './utils.js';

type LinkIssueExtras = Partial<Pick<ValidationIssue, 'location' | 'line' | 'link' | 'suggestion'>>;

/**
 * Build the common `createRegistryIssue` extras for a link issue: relative
 * location, the problematic href, the line (only when defined — required for
 * exactOptionalPropertyTypes), and an optional suggestion.
 */
function linkExtras(
  link: ResourceLink,
  sourceFilePath: string,
  projectRoot: string | undefined,
  suggestion?: string,
): LinkIssueExtras {
  return {
    location: issueLocation(sourceFilePath, locationRoot(projectRoot)),
    link: link.href,
    ...(link.line !== undefined && { line: link.line }),
    ...(suggestion !== undefined && { suggestion }),
  };
}

/**
 * One link paired with the file it was found in — the unit the fill pass takes.
 */
export interface LinkEntry {
  link: ResourceLink;
  sourceFilePath: string;
}

/**
 * A link entry paired with its ONE resolution — computed in the fill pass by
 * {@link resolveLinkEntry}, and never recomputed.
 *
 * `resolution` is absent exactly for the link types with no local target
 * (`anchor`, `external`, `email`, `embedded`, `unknown`), and present for every
 * `local_file` / `local_directory` — which is why {@link judgeLink} throws
 * rather than resolving one itself when it finds the field missing.
 */
export interface ResolvedLinkEntry extends LinkEntry {
  resolution?: ResolveLocalHrefResult;
}

/**
 * Pass 1′, step 1: resolve one entry, once.
 *
 * ⚠️ **`resolveLocalHref` is not pure, which is the whole reason this step
 * exists as its own pass.** Its absolute-path branch calls `isWithinProject`,
 * which is two `fs.realpathSync` — so "just resolve again where you need it" is
 * two extra syscalls per root-absolute link, not free string work. Resolve here;
 * carry the result.
 *
 * @param entry - A link and the file it was found in
 * @param projectRoot - Project root for absolute-path references
 */
export function resolveLinkEntry(entry: LinkEntry, projectRoot?: string): ResolvedLinkEntry {
  if (entry.link.type !== 'local_file' && entry.link.type !== 'local_directory') {
    return entry;
  }

  return {
    ...entry,
    resolution: resolveLocalHref(entry.link.href, entry.sourceFilePath, projectRoot),
  };
}

/**
 * Pass 1′, step 1 over a whole corpus: resolve every entry exactly once.
 *
 * @param entries - Links paired with their source files
 * @param projectRoot - Project root for absolute-path references
 * @returns The same entries, in the same order, each carrying its resolution
 */
export function resolveLinkEntries(
  entries: Iterable<LinkEntry>,
  projectRoot?: string,
): ResolvedLinkEntry[] {
  const resolved: ResolvedLinkEntry[] = [];
  for (const entry of entries) {
    resolved.push(resolveLinkEntry(entry, projectRoot));
  }
  return resolved;
}

/**
 * Pass 1′, step 2: the local target paths whose parent directories the fill must
 * list — the exact input for `fillSiblingNames`.
 *
 * **Pure.** It reads the resolutions {@link resolveLinkEntries} already
 * computed; it resolves nothing and touches no filesystem.
 *
 * ⚠️ **Invariant: the fill set and the judged set are the SAME OBJECTS, not two
 * computations kept in step.** This function and {@link validateLocalFileLink}
 * both read `entry.resolution` — there is no second `resolveLocalHref` call
 * anywhere for them to disagree with.
 *
 * **Why that is worth insisting on:** the table lookup THROWS on a missing row,
 * so any divergence is a crash in a shipped command rather than a wrong answer.
 * The previous shape resolved twice, once either side of the fill's `await`, and
 * `resolveLocalHref`'s absolute branch is filesystem-dependent (`isWithinProject`
 * realpaths both sides) — so a symlink changing inside that window could flip a
 * link from `absolute_escapes_root` to `resolved`, and the judge would ask about
 * a path the fill never listed. Identity closes that TOCTOU window outright.
 *
 * @param resolved - Entries already carrying their resolutions
 * @returns Resolved target paths, in entry order; duplicates are left in (the fill de-dupes by parent directory)
 */
export function linkTargetPaths(resolved: Iterable<ResolvedLinkEntry>): string[] {
  const targets: string[] = [];

  for (const { resolution } of resolved) {
    if (resolution?.kind === 'resolved') {
      targets.push(resolution.resolvedPath);
    }
  }

  return targets;
}

/**
 * What the judge reads.
 *
 * **This bag deliberately carries no filesystem handle** — no `FsLookupCache`,
 * no lister — so nothing the judge is *handed* can list a directory; that fact
 * arrives already materialised in {@link JudgeLinkOptions.siblingNames}.
 *
 * ⚠️ **Withholding the handle does not make the judge I/O-free, and this type
 * must not be read as claiming it does.** The judge's own module imports
 * `isWithinProject` and `isGitIgnored` directly, so {@link gitIgnoreSafetyIssue}
 * reaches `fs.realpathSync` and `spawnSync('git check-ignore')` without asking
 * this bag for anything. See the module docblock.
 */
export interface JudgeLinkOptions {
  /**
   * Pass-1′ table, covering every local target the judged links resolve to —
   * fill it with `fillSiblingNames(linkTargetPaths(resolved), cache)` over
   * exactly the resolved entries you are about to judge.
   */
  siblingNames: SiblingNamesTable;
  /** Project root directory (for git-ignore checking) */
  projectRoot?: string;
  /** Skip git-ignore checks (optimization when checkGitIgnored is false) */
  skipGitIgnoreCheck?: boolean;
  /** Git tracker for efficient git-ignore checking (optional, improves performance) */
  gitTracker?: GitTracker;
  /** Strictly resolve HTML fragment anchors against element ids/names (default: false). HTML fragments are often runtime-defined by JS, so a static miss is not proof of breakage. */
  checkHtmlAnchors?: boolean;
  /**
   * Deferred build-artifact model (a skill's `files:` config). A `local_file`
   * target covered by this model's `covers()` is reported as an info-severity
   * `LINK_DEFERRED_ARTIFACT` instead of an error, in two cases:
   *
   * - The target does not exist on disk yet — instead of `LINK_BROKEN_FILE`
   *   (see {@link deferredArtifactIssue}).
   * - The target exists but is gitignored — instead of `LINK_TO_GITIGNORED`
   *   (see {@link gitIgnoreSafetyIssue}); the expected state of a build
   *   artifact once a build has run, not a leak.
   *
   * Both mirror the same downgrade `vat skills validate` already performs for
   * the same declared artifact via the agent-skills walker.
   */
  deferredArtifacts?: DeferredArtifacts;
}

/**
 * The judge's options minus the filled table: the pure policy inputs, which the
 * checks needing no filesystem fact ({@link gitIgnoreSafetyIssue}) take directly.
 */
export type LinkPolicyOptions = Omit<JudgeLinkOptions, 'siblingNames'>;

/**
 * What the one-shot composition reads: the judge's options, minus the table it
 * fills itself, plus the cache it fills with.
 */
export interface ValidateLinkOptions extends LinkPolicyOptions {
  /**
   * Per-run filesystem lookup memo, shared by every link in the run.
   *
   * Required rather than optional on purpose: resolving a link needs a listing of
   * the target's parent directory, and a corpus resolves thousands of links into a
   * few hundred directories. An optional cache is one an options literal quietly
   * omits, and the omission is invisible — the answers stay correct and the
   * syscalls come back.
   */
  fsCache: FsLookupCache;
}

/**
 * Carry a one-shot caller's options across to the judge, swapping the cache it
 * filled with for the table it filled.
 *
 * **Copied field by field rather than spread, so `fsCache` cannot travel.** A
 * `{ ...options, siblingNames }` would hand the judge the very filesystem handle
 * {@link JudgeLinkOptions} exists to withhold — the property would survive in the
 * object even though the type never mentions it. The per-field
 * `...(x !== undefined && { x })` idiom is what `exactOptionalPropertyTypes`
 * requires for optional fields.
 *
 * @param options - The one-shot caller's options (may be absent entirely)
 * @param siblingNames - Table just filled for exactly the links about to be judged
 */
export function judgeOptionsFrom(
  options: ValidateLinkOptions | undefined,
  siblingNames: SiblingNamesTable,
): JudgeLinkOptions {
  return {
    siblingNames,
    ...(options?.projectRoot !== undefined && { projectRoot: options.projectRoot }),
    ...(options?.skipGitIgnoreCheck !== undefined && {
      skipGitIgnoreCheck: options.skipGitIgnoreCheck,
    }),
    ...(options?.gitTracker !== undefined && { gitTracker: options.gitTracker }),
    ...(options?.checkHtmlAnchors !== undefined && { checkHtmlAnchors: options.checkHtmlAnchors }),
    ...(options?.deferredArtifacts !== undefined && {
      deferredArtifacts: options.deferredArtifacts,
    }),
  };
}

/**
 * Decide a single already-resolved link against an already-filled sibling-name
 * table.
 *
 * **Synchronous, and it does no directory listing and no href resolution** — the
 * listing came from the fill's table, the resolution rides on `entry`. Callers
 * that have already filled (the registry, frontmatter validation) call this
 * directly; {@link validateLink} is the ad-hoc entry point that resolves and
 * fills for one link first.
 *
 * ⚠️ **It is still not I/O-free.** With `skipGitIgnoreCheck` unset and a
 * `projectRoot` set, every *existing* local target reaches
 * {@link gitIgnoreSafetyIssue}, which calls `isWithinProject` (two
 * `fs.realpathSync`) and, when no {@link GitTracker} was supplied, `isGitIgnored`
 * (a `spawnSync` of `git check-ignore`). Judging a large corpus therefore still
 * interleaves those two syscalls per existing target; only the `readdir` column
 * is filled today.
 *
 * @param entry - The link, its source file, and its one resolution
 * @param fragmentsByFile - Fragment index: file path → set of valid fragments (markdown slugs + HTML id/name)
 * @param options - Judge options, carrying the filled table
 * @returns ValidationIssue if link is broken, null if valid
 * @throws If a local entry carries no resolution, or if the table has no row for
 *   a local target's parent directory — see {@link linkTargetPaths}
 */
export function judgeLink(
  entry: ResolvedLinkEntry,
  fragmentsByFile: FragmentIndex,
  options: JudgeLinkOptions,
): ValidationIssue | null {
  const { link, sourceFilePath } = entry;

  switch (link.type) {
    case 'local_file':
    case 'local_directory':
      return validateLocalFileLink(entry, fragmentsByFile, options);

    case 'anchor':
      return validateAnchorLink(link, sourceFilePath, fragmentsByFile, options);

    case 'external':
      // External URLs are not validated - don't report them
      return null;

    case 'email':
      // Email links are valid by default
      return null;

    case 'embedded':
      // Self-contained inline resources (data:/blob:) have no target to
      // validate — valid by default, don't report them.
      return null;

    case 'unknown':
      return createRegistryIssue(
        'LINK_UNKNOWN',
        'Unknown link type',
        linkExtras(link, sourceFilePath, options.projectRoot),
      );

    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = link.type;
      return _exhaustive;
    }
  }
}

/**
 * Validate a single link in a markdown resource — the ad-hoc, one-shot entry
 * point: it fills a one-link sibling-name table and immediately judges it.
 *
 * A caller with many links should not loop over this; that reinstates one
 * directory listing per link, serialised behind the previous link's `await`.
 * Resolve once with {@link resolveLinkEntries}, fill once with
 * `fillSiblingNames(linkTargetPaths(resolved), cache)`, and call
 * {@link judgeLink} per entry instead.
 *
 * Its signature and its answers are unchanged by the fill/judge split, and are
 * pinned as such by the existing `validateLink` test corpus — several of whose
 * cases pass no `options` at all.
 *
 * @param link - The link to validate
 * @param sourceFilePath - Absolute path to the file containing the link
 * @param fragmentsByFile - Fragment index: file path → set of valid fragments (markdown slugs + HTML id/name)
 * @param options - Validation options (fsCache, projectRoot, skipGitIgnoreCheck)
 * @returns ValidationIssue if link is broken, null if valid
 *
 * @example
 * ```typescript
 * const issue = await validateLink(link, '/project/docs/guide.md', headingsMap, {
 *   fsCache,
 *   projectRoot: '/project',
 *   skipGitIgnoreCheck: false
 * });
 * if (issue) {
 *   console.log(`${issue.severity}: ${issue.message}`);
 * }
 * ```
 */
export async function validateLink(
  link: ResourceLink,
  sourceFilePath: string,
  fragmentsByFile: FragmentIndex,
  options?: ValidateLinkOptions
): Promise<ValidationIssue | null> {
  const entry = resolveLinkEntry({ link, sourceFilePath }, options?.projectRoot);

  // No options at all means no run to scope a cache to (single ad-hoc call);
  // a fresh instance is exactly the old, un-memoized behaviour.
  const siblingNames = await fillSiblingNames(
    linkTargetPaths([entry]),
    options?.fsCache ?? new FsLookupCache(),
  );

  return judgeLink(entry, fragmentsByFile, judgeOptionsFrom(options, siblingNames));
}

/**
 * Convert a resolution failure kind to a broken_file ValidationIssue. Returns
 * null for `resolved` (caller continues) and `anchor_only` (defensive no-op —
 * the parser classifies anchor-only hrefs as 'anchor', not 'local_file').
 */
export function resolutionFailureIssue(
  resolved: ReturnType<typeof resolveLocalHref>,
  link: ResourceLink,
  sourceFilePath: string,
  projectRoot?: string,
): ValidationIssue | null {
  if (resolved.kind === 'absolute_no_root') {
    return createRegistryIssue(
      'LINK_BROKEN_FILE',
      `Absolute-path link "${link.href}" requires a configured projectRoot; ` +
        `none was provided. Configure vibe-agent-toolkit.config.yaml or run ` +
        `from within a git repository.`,
      linkExtras(
        link,
        sourceFilePath,
        projectRoot,
        'Rewrite as a source-relative link, or run from a directory with a config or git ancestor.',
      ),
    );
  }

  if (resolved.kind === 'absolute_escapes_root') {
    return createRegistryIssue(
      'LINK_BROKEN_FILE',
      `Absolute-path link "${link.href}" escapes the project root via path traversal.`,
      linkExtras(link, sourceFilePath, projectRoot, ''),
    );
  }

  return null;
}

/**
 * Convert a non-existent file result into a broken_file ValidationIssue.
 * Returns null when the file exists.
 */
export function fileExistenceIssue(
  fileResult: { exists: boolean; resolvedPath: string; actualName?: string },
  link: ResourceLink,
  sourceFilePath: string,
  projectRoot?: string,
): ValidationIssue | null {
  if (fileResult.exists) return null;

  if (fileResult.actualName) {
    const expectedName = path.basename(fileResult.resolvedPath);
    return createRegistryIssue(
      'LINK_BROKEN_FILE',
      `File found but case mismatch: expected "${expectedName}" but found "${fileResult.actualName}". This will fail on case-sensitive filesystems (Linux). Update the link to match the actual filename.`,
      linkExtras(
        link,
        sourceFilePath,
        projectRoot,
        `Use "${fileResult.actualName}" instead of "${expectedName}"`,
      ),
    );
  }

  // Spell the missing file the same way the sibling `location` does: relative to
  // the project root when we know one. An absolute path here leaks the
  // developer's home directory into every CI log — the same reason `location`
  // is required to be relative.
  const missingPath = projectRoot
    ? issueLocation(fileResult.resolvedPath, projectRoot)
    : fileResult.resolvedPath;

  return createRegistryIssue(
    'LINK_BROKEN_FILE',
    `File not found: ${missingPath}`,
    linkExtras(link, sourceFilePath, projectRoot, ''),
  );
}

/**
 * Convert a missing-file result into a `LINK_DEFERRED_ARTIFACT` info issue when
 * the target is a declared-but-not-yet-materialized `files:` build artifact.
 *
 * Returns null (defer to the normal `fileExistenceIssue` / existing-file path)
 * when:
 * - the file actually exists (`fileResult.exists`) — the existence gate: an
 *   existing covered target must keep its normal anchor/gitignore treatment,
 *   never a deferred downgrade purely from `covers()`;
 * - the file exists under a different case (`fileResult.actualName` set) — a
 *   real, if mis-cased, materialized file, not a not-yet-built one;
 * - no `deferredArtifacts` model was supplied, or it doesn't cover this path.
 */
export function deferredArtifactIssue(
  fileResult: { exists: boolean; resolvedPath: string; actualName?: string },
  link: ResourceLink,
  sourceFilePath: string,
  deferredArtifacts: DeferredArtifacts | undefined,
  projectRoot?: string,
): ValidationIssue | null {
  if (fileResult.exists || fileResult.actualName || !deferredArtifacts?.covers(fileResult.resolvedPath)) {
    return null;
  }

  return createRegistryIssue(
    'LINK_DEFERRED_ARTIFACT',
    `Link targets a build artifact declared in the skill files: config, not yet materialized: ${fileResult.resolvedPath}`,
    linkExtras(link, sourceFilePath, projectRoot, ''),
  );
}

/**
 * Check git-ignore safety: a non-ignored source file must not link to a
 * gitignored target. Returns a ValidationIssue when this rule is violated,
 * null otherwise (including when checks are disabled or out of scope).
 */
export function gitIgnoreSafetyIssue(
  link: ResourceLink,
  sourceFilePath: string,
  resolvedTarget: string,
  options: LinkPolicyOptions | undefined,
): ValidationIssue | null {
  if (
    options?.skipGitIgnoreCheck === true ||
    options?.projectRoot === undefined ||
    !isWithinProject(resolvedTarget, options.projectRoot)
  ) {
    return null;
  }

  // Prefer the O(1) active-set lookup on the shared GitTracker (no spawn).
  // isIgnoredByActiveSet falls back internally to isIgnored for paths outside
  // the project root, so this is safe for the rare out-of-project case.
  // When no tracker is threaded in, fall back to isGitIgnored (one-off spawn).
  const sourceIsIgnored = options.gitTracker
    ? options.gitTracker.isIgnoredByActiveSet(sourceFilePath)
    : isGitIgnored(sourceFilePath, options.projectRoot);
  const targetIsIgnored = options.gitTracker
    ? options.gitTracker.isIgnoredByActiveSet(resolvedTarget)
    : isGitIgnored(resolvedTarget, options.projectRoot);

  if (sourceIsIgnored || !targetIsIgnored) return null;

  // A files:-declared DEST that already exists on disk and is gitignored is
  // the expected post-build state of a materialized build artifact (gitignored
  // dist/ output), not a leak. This check is deliberately unconditional on
  // existence — the target reaching this point already implies it exists (the
  // caller only invokes gitIgnoreSafetyIssue after fileExistenceIssue passes).
  // Downgrade to the same info-severity code deferredArtifactIssue emits for
  // the not-yet-materialized half of the same lifecycle, rather than
  // escalating to LINK_TO_GITIGNORED. An uncovered target still reports the
  // leak below.
  //
  // DEST-ONLY (coversDest, not covers): a files: SOURCE is a real file the
  // author pointed at, not a build output — if it's gitignored, linking to it
  // is exactly the leak this rule exists to catch, so source coverage must
  // NOT exempt it here.
  if (options.deferredArtifacts?.coversDest(resolvedTarget)) {
    return createRegistryIssue(
      'LINK_DEFERRED_ARTIFACT',
      `Link targets a build artifact declared in the skill files: config, materialized and (as expected) gitignored: ${resolvedTarget}`,
      linkExtras(link, sourceFilePath, options.projectRoot, ''),
    );
  }

  return createRegistryIssue(
    'LINK_TO_GITIGNORED',
    `Non-ignored file links to gitignored file: ${resolvedTarget}. Gitignored files are local-only and will not exist in the repository. Remove this link or unignore the target file.`,
    linkExtras(link, sourceFilePath, options.projectRoot, ''),
  );
}

/**
 * Validate a local file link (with optional anchor).
 *
 * Synchronous, and it resolves nothing and lists nothing: the resolution comes
 * off the entry (the identity {@link linkTargetPaths} depends on) and the
 * existence/case fact comes out of `options.siblingNames`.
 *
 * It can still reach the filesystem, through {@link gitIgnoreSafetyIssue} —
 * `fs.realpathSync` via `isWithinProject`, plus `spawnSync('git check-ignore')`
 * when no {@link GitTracker} was supplied. Those two facts are not filled yet;
 * do not describe this function as free of I/O until they are.
 */
function validateLocalFileLink(
  entry: ResolvedLinkEntry,
  fragmentsByFile: FragmentIndex,
  options: JudgeLinkOptions,
): ValidationIssue | null {
  const { link, sourceFilePath, resolution: resolved } = entry;

  if (resolved === undefined) {
    // Resolving here would reinstate exactly the double-resolution (and the
    // TOCTOU window) that carrying the resolution exists to remove.
    throw new Error(
      `Local link "${link.href}" in ${sourceFilePath} was judged without a ` +
        `resolution. Build entries with resolveLinkEntries()/resolveLinkEntry() ` +
        `— the judge must not resolve, because resolving is filesystem work.`,
    );
  }

  if (resolved.kind !== 'resolved') {
    // anchor_only → null no-op; absolute_no_root / absolute_escapes_root → broken_file.
    return resolutionFailureIssue(resolved, link, sourceFilePath, options.projectRoot);
  }

  const fileResult = validateResolvedFile(resolved.resolvedPath, options.siblingNames);

  const deferred = deferredArtifactIssue(
    fileResult,
    link,
    sourceFilePath,
    options.deferredArtifacts,
    options.projectRoot,
  );
  if (deferred) return deferred;

  const notFound = fileExistenceIssue(fileResult, link, sourceFilePath, options.projectRoot);
  if (notFound) return notFound;

  const gitIgnoreIssue = gitIgnoreSafetyIssue(link, sourceFilePath, fileResult.resolvedPath, options);
  if (gitIgnoreIssue) return gitIgnoreIssue;

  if (resolved.anchor) {
    const check = checkAnchor(
      resolved.anchor,
      fileResult.resolvedPath,
      fragmentsByFile,
      options.checkHtmlAnchors ?? false,
    );
    if (check === 'broken') {
      return createRegistryIssue(
        'LINK_BROKEN_ANCHOR',
        `Anchor not found: #${resolved.anchor} in ${fileResult.resolvedPath}`,
        linkExtras(link, sourceFilePath, options.projectRoot, ''),
      );
    }
  }

  return null;
}

/**
 * Exhaustiveness guard for the {@link AnchorCheck} union: a compile error at the
 * call site means a new variant was added without being handled here.
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled AnchorCheck variant: ${String(value)}`);
}

/**
 * Validate an anchor link (within current file).
 */
function validateAnchorLink(
  link: ResourceLink,
  sourceFilePath: string,
  fragmentsByFile: FragmentIndex,
  options: JudgeLinkOptions,
): ValidationIssue | null {
  // Extract anchor (strip leading #)
  const anchor = link.href.startsWith('#') ? link.href.slice(1) : link.href;

  // Validate anchor exists in current file
  const check = checkAnchor(anchor, sourceFilePath, fragmentsByFile, options.checkHtmlAnchors ?? false);

  switch (check) {
    case 'skip':
    case 'valid':
      return null;
    case 'broken':
      return createRegistryIssue(
        'LINK_BROKEN_ANCHOR',
        `Anchor not found: ${link.href}`,
        linkExtras(link, sourceFilePath, options.projectRoot, ''),
      );
    default:
      return assertNever(check);
  }
}


/**
 * Verify that the resolved filesystem path exists with the correct case, by
 * reading the pass-1′ listing column rather than touching the filesystem.
 *
 * **Deliberately does not report whether the target is a directory.** It used
 * to, at the cost of an `fs.stat` for every link target that exists — and no
 * caller ever read the answer. {@link validateLocalFileLink} reads this result
 * at four sites ({@link deferredArtifactIssue}, {@link fileExistenceIssue},
 * {@link gitIgnoreSafetyIssue} and the anchor check), and every one of them
 * takes only `exists`, `resolvedPath` or `actualName`. A future
 * link-points-at-a-directory check belongs in the same pass-1′ table this now
 * reads — widen the table with a directory-kind column filled over the paths it
 * needs, never re-stat one target at judgement time.
 *
 * @param resolvedPath - Absolute filesystem path produced by {@link resolveLocalHref}.
 * @param siblingNames - Pass-1′ table, filled over exactly these target paths.
 * @returns Object with exists flag, the path, and optional case-mismatch info.
 */
function validateResolvedFile(
  resolvedPath: string,
  siblingNames: SiblingNamesTable,
): { exists: boolean; resolvedPath: string; actualName?: string } {
  const verification = classifyFilenameCaseFrom(siblingNames, resolvedPath);

  const result: { exists: boolean; resolvedPath: string; actualName?: string } = {
    exists: verification.exists,
    resolvedPath,
  };

  if (verification.actualName) {
    result.actualName = verification.actualName;
  }

  return result;
}

/** Result of checking an anchor against the fragment index. */
export type AnchorCheck = 'skip' | 'valid' | 'broken';

/**
 * A file's fragment targets plus how to match against them. HTML `id`/`name`
 * anchors are matched case-sensitively; markdown heading slugs are case-folded.
 * The policy lives on the entry rather than being re-derived from the file
 * extension at match time, so a new resource format only has to set this flag.
 */
export interface FragmentIndexEntry {
  /** `true` for case-sensitive matching (HTML ids), `false` for case-folded (markdown slugs). */
  caseSensitive: boolean;
  fragments: Set<string>;
}

/** File path → its fragment targets and matching policy. */
export type FragmentIndex = Map<string, FragmentIndexEntry>;

/**
 * Whether a path is an HTML resource (`.html`/`.htm`). The single place the
 * extension drives format-specific behavior: case-sensitive ids (via
 * {@link fragmentIndexEntry}) and the HTML top-fragment navigation rule.
 */
export function isHtmlPath(filePath: string): boolean {
  return /\.html?$/i.test(filePath);
}

/** Build one index entry, choosing the case-folding policy from the file type. */
export function fragmentIndexEntry(filePath: string, fragments: Set<string> = new Set()): FragmentIndexEntry {
  return { caseSensitive: isHtmlPath(filePath), fragments };
}

/**
 * Build a {@link FragmentIndex} from `[path, fragments]` pairs, deriving each
 * entry's matching policy from its path. Single construction path shared by the
 * registry and tests.
 */
export function fragmentIndex(entries: Iterable<readonly [string, Set<string>]> = []): FragmentIndex {
  const map: FragmentIndex = new Map();
  for (const [filePath, fragments] of entries) {
    map.set(filePath, fragmentIndexEntry(filePath, fragments));
  }
  return map;
}

/**
 * Whether an HTML fragment is a structural, non-anchor hash: an SPA route
 * (`#/route`) or a hash-encoded param string (`#id=1&mode=x`). Neither is
 * ever a literal element id, regardless of `checkHtmlAnchors`.
 */
function isStructuralHtmlFragment(anchor: string): boolean {
  return anchor.startsWith('/') || anchor.includes('=') || anchor.includes('&');
}

/**
 * Resolve an HTML-target anchor. Isolated from {@link checkAnchor} to keep
 * cognitive complexity down.
 *
 * - Empty fragment / `top` (case-insensitive) — always `'valid'` (HTML
 *   top-navigation rule).
 * - Structural non-anchor (`#/route`, `#k=v`, `#k=v&j=w`) — always `'skip'`;
 *   these are never element ids, so there is nothing to resolve.
 * - `checkHtmlAnchors === false` (default) — `'skip'`: HTML fragments are
 *   frequently defined at runtime by JS (hash routers, hash query-params),
 *   so the static id/name set in the source HTML is not authoritative.
 * - `checkHtmlAnchors === true` — resolve against the indexed ids/names
 *   (case-sensitive).
 */
function checkHtmlAnchor(
  anchor: string,
  entry: FragmentIndexEntry,
  checkHtmlAnchors: boolean,
): AnchorCheck {
  if (anchor === '' || anchor.toLowerCase() === 'top') {
    return 'valid';
  }
  if (isStructuralHtmlFragment(anchor)) {
    return 'skip';
  }
  if (!checkHtmlAnchors) {
    return 'skip';
  }
  return entry.fragments.has(anchor) ? 'valid' : 'broken';
}

/**
 * Check whether a fragment exists in the target file's anchor set.
 *
 * - `'skip'`  — target file is not indexed; we cannot prove the anchor is
 *   broken, so callers must not emit an issue.
 * - HTML targets are delegated to {@link checkHtmlAnchor} (top-navigation
 *   rule, structural non-anchors, and the `checkHtmlAnchors` opt-in gate).
 * - Markdown targets resolve against the indexed heading slugs, case-folded.
 *
 * @param anchor - Fragment without the leading `#`.
 * @param targetFilePath - Absolute path of the file the fragment lives in.
 * @param fragmentsByFile - Fragment index carrying each file's matching policy.
 * @param checkHtmlAnchors - Strictly resolve HTML fragments against indexed
 *   element ids/names (default: false — see {@link checkHtmlAnchor}).
 */
export function checkAnchor(
  anchor: string,
  targetFilePath: string,
  fragmentsByFile: FragmentIndex,
  checkHtmlAnchors = false,
): AnchorCheck {
  const entry = fragmentsByFile.get(targetFilePath);
  if (!entry) {
    return 'skip';
  }
  if (isHtmlPath(targetFilePath)) {
    return checkHtmlAnchor(anchor, entry, checkHtmlAnchors);
  }
  const found = entry.caseSensitive
    ? entry.fragments.has(anchor)
    : entry.fragments.has(anchor.toLowerCase());
  return found ? 'valid' : 'broken';
}

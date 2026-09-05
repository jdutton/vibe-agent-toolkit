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
 * **Two passes, not one — and the fill is still not finished.**
 *
 * The fill pass ({@link fillLinkFacts}) resolves every link once
 * ({@link resolveLinkEntries}), names the local targets
 * ({@link linkTargetPaths}), and materialises two columns over them
 * concurrently: their parent directories' listings (`fillSiblingNames`) and
 * their canonical paths (`fillRealpaths`, together with the project root). The
 * judge pass ({@link judgeLink}) is synchronous and does **no directory
 * listing, no href resolution and no realpath** — every one of those facts
 * travels to it, the two columns in {@link LinkFactTables} and the resolution on
 * the entry.
 *
 * ⚠️ **The judge is still not I/O-free, and no comment in this file may claim it
 * is.** One fact judgement needs remains unfilled, and it is read at judgement
 * time through a direct import rather than through anything the judge is handed:
 *
 * - `isGitIgnored` — a `spawnSync` of `git check-ignore`, reached from
 *   {@link gitIgnoreSafetyIssue} for every existing local target whenever
 *   `skipGitIgnoreCheck !== true` and no {@link GitTracker} was supplied (a real
 *   configuration: the registry makes its tracker conditional).
 *
 * That is the next column the fill should grow (ledger entry D9), and it is
 * explicitly not part of the realpath change. Until it is filled, judging a
 * corpus does interleave I/O — just far less of it, and never a `readdir` and
 * never a `realpath`.
 *
 * {@link validateLink} is the one-shot composition for a caller with a single
 * link.
 */

import path from 'node:path';

import { createRegistryIssue, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import {
  classifyFilenameCaseFrom,
  type FilenameMatch,
  fillRealpaths,
  fillSiblingNames,
  FsLookupCache,
  issueLocation,
  type RealpathTable,
  type SiblingNamesTable,
  toNfc,
} from '@vibe-agent-toolkit/utils';
import {
  isGitIgnored,
  type GitTracker,
} from '@vibe-agent-toolkit/utils/git';

import type { DeferredArtifacts } from './deferred-artifacts.js';
import type { ResourceLink } from './types.js';
import {
  isWithinProjectFrom,
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
 * so any divergence is a crash in a shipped command rather than a wrong answer
 * — loudly in two of the three lanes, and mislabelled as a schema error in the
 * third (see {@link LinkFactTables}). The previous shape resolved twice, once
 * either side of the fill's `await`, and
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
 * The pass-1′ columns the judge reads. Fill both with {@link fillLinkFacts}.
 *
 * ⚠️ **A missing row in either table THROWS**, by design (`siblingNamesFrom`,
 * `realpathFrom`): a divergence between the filled set and the judged set is a
 * programming error, and a crash names it — where a silent recompute would only
 * make the run slower and a `null` degradation would answer wrongly. The
 * corollary is that the fill and the judge must also agree on *whether a column
 * is populated at all*, which is what {@link needsRealpathColumn} is for.
 *
 * ⚠️ **"The crash names itself" now holds in all three judging lanes — keep it
 * that way.** In the registry's own link pass (`ResourceRegistry.validate`), in
 * {@link validateLink}, and in the **frontmatter** lane, the throw propagates
 * and its message (`No canonical path for "…". Fill it with fillRealpaths()
 * before judging.`) reaches the operator intact. The frontmatter lane was the
 * exception until the collection-schema `try` in `resource-registry.ts` was
 * narrowed to the schema load/compile alone: `validateFrontmatterLinks` used to
 * sit inside it, so a fill/judge divergence surfaced as `Failed to load or parse
 * frontmatter schema '<schema>'` against a file whose schema was perfectly fine,
 * once per resource in the collection. Do not widen that `try` back over link
 * validation, and do not add a `catch` around these calls anywhere — turning the
 * crash into a finding is exactly what this design refuses.
 */
export interface LinkFactTables {
  /**
   * The listing column, covering every local target the judged links resolve
   * to. Keyed by parent directory — `fillSiblingNames` derives that key itself,
   * so pass it the target *file* paths.
   */
  siblingNames: SiblingNamesTable;
  /**
   * The realpath column: every local target **plus the project root**, keyed by
   * the path string exactly as the fill was handed it.
   *
   * **Empty whenever {@link needsRealpathColumn} is false** — judgement cannot
   * reach it then, so filling it would be pure added syscalls on the common
   * path.
   */
  realpaths: RealpathTable;
}

/**
 * What the judge reads: the filled columns, plus the policy.
 *
 * **This bag deliberately carries no filesystem handle** — no `FsLookupCache`,
 * no lister — so nothing the judge is *handed* can list a directory or
 * canonicalize a path; both facts arrive already materialised in
 * {@link LinkFactTables}.
 *
 * ⚠️ **Withholding the handle does not make the judge I/O-free, and this type
 * must not be read as claiming it does.** The judge's own module imports
 * `isGitIgnored` directly, so {@link gitIgnoreSafetyIssue} still reaches
 * `spawnSync('git check-ignore')` without asking this bag for anything. See the
 * module docblock.
 */
export interface JudgeLinkOptions extends LinkFactTables {
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
 * The judge's options minus the filled columns: the policy inputs alone.
 *
 * ⚠️ **This is not "the inputs of the checks that need no filesystem fact" — no
 * such check exists.** {@link gitIgnoreSafetyIssue} needs the canonical path of
 * its target and of the project root, and reads both out of
 * {@link LinkFactTables.realpaths}; it takes {@link GitIgnoreCheckOptions}, not
 * this type. `LinkPolicyOptions` is only the *carrier* shape — what
 * {@link ValidateLinkOptions} extends, and what {@link needsRealpathColumn}
 * inspects — never a complete input to judging.
 */
export type LinkPolicyOptions = Omit<JudgeLinkOptions, keyof LinkFactTables>;

/**
 * What {@link gitIgnoreSafetyIssue} reads: the policy plus the one filled column
 * it consumes. Spelled as its own type so the check's dependency on a *filled
 * table* is visible in its signature rather than buried in its body.
 */
export type GitIgnoreCheckOptions = LinkPolicyOptions & Pick<LinkFactTables, 'realpaths'>;

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
 * Whether judgement can reach the realpath column — **the one gate the fill and
 * the judge MUST agree on.**
 *
 * {@link gitIgnoreSafetyIssue} short-circuits before it ever asks about a
 * canonical path when git-ignore checking is off or there is no project root; in
 * that configuration a realpath fill would be pure added syscalls, which is the
 * exact regression the realpath column exists to remove. So the fill asks this
 * predicate too, and fills an EMPTY table when it is false.
 *
 * ⚠️ **Never inline this condition on either side.** `realpathFrom` throws on a
 * missing row, so a fill that skips the column while the judge still reads it is
 * not a slow path — it is a crash in a shipped command, and in the frontmatter
 * lane not even a legible one (see {@link LinkFactTables}).
 *
 * Returns a type predicate so both call sites get `projectRoot: string` narrowed
 * out of it, rather than re-testing it and drifting.
 *
 * @param policy - Any options bag carrying the two policy fields
 */
export function needsRealpathColumn<
  T extends { projectRoot?: string | undefined; skipGitIgnoreCheck?: boolean | undefined },
>(policy: T): policy is T & { projectRoot: string } {
  return policy.skipGitIgnoreCheck !== true && policy.projectRoot !== undefined;
}

/**
 * Pass 1′: materialise every column the judge will read, over exactly the
 * entries about to be judged.
 *
 * The two fills run **concurrently** — they are independent syscall sets, and
 * sequencing them would serialise every `realpath` behind the last `readdir`.
 *
 * ⚠️ **"Concurrently" here is a change in KIND, not just an ordering.** The two
 * waves now overlap, and they are bounded by different things:
 * `fillSiblingNames` by distinct *directories* (hundreds on a large corpus),
 * `fillRealpaths` by distinct *files* — ~770 on VAT itself and several thousand
 * on the 1,484-document adopter. Both are issued as a single `Promise.all` each,
 * so the peak in-flight request count is the sum, landing on libuv's 4-thread
 * pool. The pool queues the excess rather than spawning for it, so this is a
 * queue-depth change and not an unbounded fan-out — but it is a real one, and
 * anything added to this function should be weighed against it rather than
 * assumed free.
 *
 * ⚠️ **TOCTOU: canonicalization moved EARLIER, and that widens one window.** At
 * HEAD the `realpath` ran strictly *after* the existence verdict, at judgement
 * time. It now runs here, concurrent with the very `readdir` that produces that
 * verdict, so a target created or deleted inside the window is judged from two
 * facts taken at slightly different instants. Both directions are reachable: a
 * target can be listed-as-present but realpath'd-as-absent, in which case its row
 * falls back to `safePath.resolve` and — under a project root reached through a
 * symlink — containment reads false, the check returns early, and the git-ignore
 * check is silently skipped; or listed-as-absent but realpath'd-as-present, in
 * which case the existence check returns first and the row is simply never read.
 * This is **accepted, not closed**: closing it needs a filesystem snapshot that
 * does not exist. It differs from the resolution TOCTOU argued on
 * {@link linkTargetPaths}, which *is* closed outright, by identity — that one
 * could be, this one cannot.
 *
 * ⚠️ **With the gate open, this always costs at least one syscall — even with
 * zero local targets** — because `policy.projectRoot` is appended
 * unconditionally. `fillRealpaths` documents that empty input yields an empty
 * table with no syscalls; that is a property of *that* function and does not
 * carry across to this one. The no-syscall case here is the gate being CLOSED
 * ({@link needsRealpathColumn} false), never an empty target list.
 *
 * ⚠️ **The realpath fill is a deliberate SUPERSET of what the judge asks
 * about.** The judge only reaches {@link gitIgnoreSafetyIssue} for targets that
 * *exist* — the deferred-artifact and existence checks return first — whereas
 * this canonicalizes every resolved target. Narrowing it to "targets that exist"
 * would mean recomputing the existence verdict here, i.e. two computations kept
 * in step: precisely the drift hazard {@link linkTargetPaths} exists to close. A
 * superset is always safe (`realpathFrom` throws only on a *missing* row), and
 * it costs one failed `realpath` per broken link — which a green corpus does not
 * pay at all. Do not "optimize" this into a bug.
 *
 * The project root is a row of its own, and that is where half the measured
 * syscalls went: canonicalizing a run-constant root once per *link* was the
 * defect (ledger D8), not the realpath itself.
 *
 * @param resolved - Entries already carrying their resolutions
 * @param fsCache - Per-run lookup cache (one instance per validation run)
 * @param policy - The judge's policy, read only through {@link needsRealpathColumn}
 * @returns Both columns, filled over the same target set
 */
export async function fillLinkFacts(
  resolved: readonly ResolvedLinkEntry[],
  fsCache: FsLookupCache,
  policy: { projectRoot?: string | undefined; skipGitIgnoreCheck?: boolean | undefined },
): Promise<LinkFactTables> {
  const targets = linkTargetPaths(resolved);

  const [siblingNames, realpaths] = await Promise.all([
    fillSiblingNames(targets, fsCache),
    needsRealpathColumn(policy)
      ? fillRealpaths([...targets, policy.projectRoot], fsCache)
      : Promise.resolve<RealpathTable>(new Map()),
  ]);

  return { siblingNames, realpaths };
}

/**
 * Carry a one-shot caller's options across to the judge, swapping the cache it
 * filled with for the columns it filled.
 *
 * **Copied field by field rather than spread, so `fsCache` cannot travel.** A
 * `{ ...options, siblingNames }` would hand the judge the very filesystem handle
 * {@link JudgeLinkOptions} exists to withhold — the property would survive in the
 * object even though the type never mentions it. The per-field
 * `...(x !== undefined && { x })` idiom is what `exactOptionalPropertyTypes`
 * requires for optional fields.
 *
 * @param options - The one-shot caller's options (may be absent entirely)
 * @param tables - Columns just filled by {@link fillLinkFacts} for exactly the
 *   links about to be judged
 */
export function judgeOptionsFrom(
  options: ValidateLinkOptions | undefined,
  tables: LinkFactTables,
): JudgeLinkOptions {
  return {
    siblingNames: tables.siblingNames,
    realpaths: tables.realpaths,
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
 * **Synchronous, and it does no directory listing, no href resolution and no
 * realpath** — the listing and the canonical paths came from the fill's columns,
 * the resolution rides on `entry`. Callers that have already filled (the
 * registry, frontmatter validation) call this directly; {@link validateLink} is
 * the ad-hoc entry point that resolves and fills for one link first.
 *
 * ⚠️ **It is still not I/O-free.** With `skipGitIgnoreCheck` unset and a
 * `projectRoot` set, every *existing* local target reaches
 * {@link gitIgnoreSafetyIssue}, which calls `isGitIgnored` — a `spawnSync` of
 * `git check-ignore` — whenever no {@link GitTracker} was supplied. Judging a
 * large corpus therefore still interleaves that one spawn per existing target;
 * it is the last unfilled column (ledger entry D9), and it is not addressed
 * here.
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
 * directory listing and one project-root realpath per link, serialised behind
 * the previous link's `await`. Resolve once with {@link resolveLinkEntries},
 * fill once with {@link fillLinkFacts}, and call {@link judgeLink} per entry
 * instead.
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
  const tables = await fillLinkFacts(
    [entry],
    options?.fsCache ?? new FsLookupCache(),
    options ?? {},
  );

  return judgeLink(entry, fragmentsByFile, judgeOptionsFrom(options, tables));
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
 * What {@link validateResolvedFile} learned about one link target, read by every
 * downstream issue builder. The helpers below each take the narrowest slice of
 * it they actually use, so a unit test hands only the fields under test.
 */
export interface FileVerification {
  /** Does the target resolve at all — on the machine running validation. */
  exists: boolean;
  /** Absolute filesystem path the link resolved to. */
  resolvedPath: string;
  /** How the asked-for basename matched a directory entry. */
  match: FilenameMatch;
  /** The entry really on disk, verbatim, when it differs from what was asked for. */
  actualName?: string;
}

/**
 * Render a filename with every non-ASCII code point escaped (`caf\u{E9}.txt`).
 *
 * ⚠️ **Mandatory for {@link normalizationMismatchIssue}, not decoration.** The
 * whole finding is that two strings which render as the *same glyphs* are
 * different bytes. A message quoting both verbatim shows the reader two
 * identical-looking names and asserts they differ — which reads as a VAT bug,
 * not as a finding. Escaping is what makes the difference legible in a terminal
 * or a CI log.
 *
 * @param name - A filename
 * @returns The same text with non-ASCII code points as `\u{...}` escapes
 */
export function escapeNonAscii(name: string): string {
  return [...name]
    .map((char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return codePoint < 0x80 ? char : String.raw`\u{` + `${codePoint.toString(16).toUpperCase()}}`;
    })
    .join('');
}

/**
 * Convert a **fold-only** match into a `LINK_NORMALIZATION_MISMATCH` warning:
 * the target is on disk, but the link's spelling and the filename's spelling are
 * the same visible characters in different Unicode normalization forms.
 *
 * Returns null for every other {@link FilenameMatch} — `'exact'` is the healthy
 * case, and `'case_mismatch'`/`'absent'` are already reported (as errors) by
 * {@link fileExistenceIssue}, which runs first.
 *
 * ⚠️ **Why this is a warning and not `LINK_BROKEN_FILE`.** The file genuinely
 * exists and the link genuinely opens where it was written: macOS/APFS and
 * Windows reconcile NFC against NFD at the syscall level. Reporting it as broken
 * would reinstate the exact false positive that folding fixed (the enumerated-vs-derived
 * path class, collected in docs/architecture/resource-scanning-and-caching.md §3.6 —
 * an accented file that plainly exists reported as missing). What folding *also*
 * did was hide the converse: on Linux/ext4 the two forms are simply different
 * filenames, so the link 404s on CI and on most deploy targets while the author's
 * machine says everything is fine. Warning is the honest severity for a finding
 * whose verdict depends on which machine asks.
 *
 * ⚠️ **The remedy names NFC on both sides, deliberately — do not "simplify" it
 * to *use the name on disk*.** Rewriting the link to match an NFD filename does
 * produce a byte-identical pair, but editors, browsers and git checkouts
 * routinely re-normalize typed text to NFC, so that spelling is liable to be
 * silently rewritten and break again. Normalizing the file's own name is the
 * stable end of the pair.
 */
export function normalizationMismatchIssue(
  fileResult: Pick<FileVerification, 'match' | 'resolvedPath' | 'actualName'>,
  link: ResourceLink,
  sourceFilePath: string,
  projectRoot?: string,
): ValidationIssue | null {
  if (fileResult.match !== 'normalized' || fileResult.actualName === undefined) return null;

  const askedName = path.basename(fileResult.resolvedPath);
  const nfcName = toNfc(fileResult.actualName);

  return createRegistryIssue(
    'LINK_NORMALIZATION_MISMATCH',
    `Link resolves only after Unicode normalization: the link spells the filename ` +
      `"${escapeNonAscii(askedName)}" but the file on disk is named ` +
      `"${escapeNonAscii(fileResult.actualName)}". Same visible name, different bytes — ` +
      `this resolves on macOS and Windows and fails on a byte-exact filesystem (Linux).`,
    linkExtras(
      link,
      sourceFilePath,
      projectRoot,
      `Normalize both to NFC: name the file "${escapeNonAscii(nfcName)}" on disk and ` +
        `write the link with that same spelling.`,
    ),
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
 *
 * **The containment test is a table read, not a syscall** — hence
 * {@link GitIgnoreCheckOptions} rather than {@link LinkPolicyOptions}. The gate
 * it opens on is {@link needsRealpathColumn}, the same predicate
 * {@link fillLinkFacts} uses to decide whether to populate that column: when it
 * is false this returns before touching `options.realpaths`, and the table it
 * would have read is legitimately empty.
 *
 * ⚠️ **It can still spawn.** With no {@link GitTracker} threaded in,
 * `isGitIgnored` runs `git check-ignore` per call — the one remaining unfilled
 * column (ledger entry D9).
 */
export function gitIgnoreSafetyIssue(
  link: ResourceLink,
  sourceFilePath: string,
  resolvedTarget: string,
  options: GitIgnoreCheckOptions | undefined,
): ValidationIssue | null {
  // Same predicate the fill asked, so the two can never disagree about whether
  // `options.realpaths` holds the rows the next line reads.
  if (options === undefined || !needsRealpathColumn(options)) {
    return null;
  }

  if (!isWithinProjectFrom(options.realpaths, resolvedTarget, options.projectRoot)) {
    return null;
  }

  // Prefer the O(1) active-set lookup on the shared GitTracker (no spawn) — the
  // in-repo path, and the only cheap one.
  //
  // ⚠️ **The out-of-root path is not cheap, and this comment used to claim it
  // was** ("safe for the rare out-of-project case", unmeasured). Measured
  // 2026-08 on the D9 parity fixture: an out-of-root path costs **185–427 ms**
  // against **12–28 ms** for every in-repo path — an order of magnitude, per
  // path. `isIgnoredByActiveSet` delegates to `isIgnored` outside the project
  // root, and `isIgnored`'s exit-128 recovery walk spawns `git check-ignore`
  // once per ancestor up to `/`. The cost lives on that function's own docstring
  // in `@vibe-agent-toolkit/utils` (`git-tracker.ts`); do not restate the
  // mechanism here, and do not assert cheapness — asserting it is how the next
  // reader skips the measurement.
  //
  // Correct either way, and mostly off the expensive path AT THIS SITE: the
  // `isWithinProjectFrom` guard above already returned for an out-of-project
  // `resolvedTarget`. `sourceFilePath` carries no such guard, so the first call
  // below can still take it. Any lane feeding out-of-root paths in bulk keeps
  // the per-path spawn.
  //
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
 * Synchronous, and it resolves nothing, lists nothing and realpaths nothing: the
 * resolution comes off the entry (the identity {@link linkTargetPaths} depends
 * on), the existence/case fact out of `options.siblingNames`, and the
 * containment fact out of `options.realpaths`.
 *
 * It can still reach the filesystem, through {@link gitIgnoreSafetyIssue} —
 * `spawnSync('git check-ignore')` when no {@link GitTracker} was supplied. That
 * fact is not filled yet (ledger entry D9); do not describe this function as
 * free of I/O until it is.
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

  // LAST, and that position is load-bearing: this function returns at most one
  // issue, so anything placed above an error would mask it. Every link that
  // produced an issue before still produces the same one; only links that
  // previously produced `null` can reach this line. The change is additive to
  // the gate, never a weakening of it.
  return normalizationMismatchIssue(fileResult, link, sourceFilePath, options.projectRoot);
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
 * at five sites ({@link deferredArtifactIssue}, {@link fileExistenceIssue},
 * {@link gitIgnoreSafetyIssue}, the anchor check and
 * {@link normalizationMismatchIssue}), and every one of them takes only
 * `exists`, `resolvedPath`, `actualName` or `match`. A future
 * link-points-at-a-directory check belongs in the same pass-1′ table this now
 * reads — widen the table with a directory-kind column filled over the paths it
 * needs, never re-stat one target at judgement time.
 *
 * ⚠️ **`match` is not redundant with `exists`**, even though `exists` is
 * derivable from it. Two of the four kinds are "the file resolves"
 * (`'exact'` and `'normalized'`), and only the first of those resolves on a
 * byte-exact filesystem — see {@link normalizationMismatchIssue}. Dropping the
 * field is how the Linux-only breakage became invisible in the first place.
 *
 * @param resolvedPath - Absolute filesystem path produced by {@link resolveLocalHref}.
 * @param siblingNames - Pass-1′ table, filled over exactly these target paths.
 * @returns Object with exists flag, the path, the match kind, and optional case-mismatch info.
 */
function validateResolvedFile(
  resolvedPath: string,
  siblingNames: SiblingNamesTable,
): FileVerification {
  const verification = classifyFilenameCaseFrom(siblingNames, resolvedPath);

  const result: FileVerification = {
    exists: verification.exists,
    resolvedPath,
    match: verification.match,
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
 * registry and tests — which is what lets the key normalization below live in
 * exactly one place.
 *
 * **Keys are Unicode NFC (`toNfc`), not the raw path.** The index is built from
 * *enumerated* paths and queried by {@link checkAnchor} with a path *derived
 * from markdown link text*; on macOS those routinely differ in normalization
 * form for the same file, and an exact-string miss here is silent — a miss
 * answers `'skip'`, so the anchor is simply never checked. One of the three sites of the
 * enumerated-vs-derived path class, collected in docs/architecture/resource-scanning-and-caching.md §3.6.
 * Only the key is normalized: the entry's matching policy still derives from the
 * raw path, and `isHtmlPath` is extension-based and normalization-agnostic.
 */
export function fragmentIndex(entries: Iterable<readonly [string, Set<string>]> = []): FragmentIndex {
  const map: FragmentIndex = new Map();
  for (const [filePath, fragments] of entries) {
    map.set(toNfc(filePath), fragmentIndexEntry(filePath, fragments));
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
  // NFC on both sides — see {@link fragmentIndex} for why the key is normalized.
  const entry = fragmentsByFile.get(toNfc(targetFilePath));
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

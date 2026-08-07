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
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { createRegistryIssue, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import {
  FsLookupCache,
  isGitIgnored,
  type GitTracker,
  issueLocation,
  verifyCaseSensitiveFilename,
} from '@vibe-agent-toolkit/utils';

import type { DeferredArtifacts } from './deferred-artifacts.js';
import type { ResourceLink } from './types.js';
import { isWithinProject, locationRoot, resolveLocalHref } from './utils.js';

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
 * Options for link validation.
 */
export interface ValidateLinkOptions {
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
 * Validate a single link in a markdown resource.
 *
 * @param link - The link to validate
 * @param sourceFilePath - Absolute path to the file containing the link
 * @param fragmentsByFile - Fragment index: file path → set of valid fragments (markdown slugs + HTML id/name)
 * @param options - Validation options (projectRoot, skipGitIgnoreCheck)
 * @returns ValidationIssue if link is broken, null if valid
 *
 * @example
 * ```typescript
 * const issue = await validateLink(link, '/project/docs/guide.md', headingsMap, {
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
  switch (link.type) {
    case 'local_file':
    case 'local_directory':
      return await validateLocalFileLink(link, sourceFilePath, fragmentsByFile, options);

    case 'anchor':
      return await validateAnchorLink(link, sourceFilePath, fragmentsByFile, options);

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
        linkExtras(link, sourceFilePath, options?.projectRoot),
      );

    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = link.type;
      return _exhaustive;
    }
  }
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
  options: ValidateLinkOptions | undefined,
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
 */
async function validateLocalFileLink(
  link: ResourceLink,
  sourceFilePath: string,
  fragmentsByFile: FragmentIndex,
  options?: ValidateLinkOptions
): Promise<ValidationIssue | null> {
  const resolved = resolveLocalHref(link.href, sourceFilePath, options?.projectRoot);

  if (resolved.kind !== 'resolved') {
    // anchor_only → null no-op; absolute_no_root / absolute_escapes_root → broken_file.
    return resolutionFailureIssue(resolved, link, sourceFilePath, options?.projectRoot);
  }

  // No options at all means no run to scope a cache to (single ad-hoc call);
  // a fresh instance is exactly the old, un-memoized behaviour.
  const fileResult = await validateResolvedFile(
    resolved.resolvedPath,
    options?.fsCache ?? new FsLookupCache(),
  );

  const deferred = deferredArtifactIssue(
    fileResult,
    link,
    sourceFilePath,
    options?.deferredArtifacts,
    options?.projectRoot,
  );
  if (deferred) return deferred;

  const notFound = fileExistenceIssue(fileResult, link, sourceFilePath, options?.projectRoot);
  if (notFound) return notFound;

  const gitIgnoreIssue = gitIgnoreSafetyIssue(link, sourceFilePath, fileResult.resolvedPath, options);
  if (gitIgnoreIssue) return gitIgnoreIssue;

  if (resolved.anchor) {
    const check = checkAnchor(
      resolved.anchor,
      fileResult.resolvedPath,
      fragmentsByFile,
      options?.checkHtmlAnchors ?? false,
    );
    if (check === 'broken') {
      return createRegistryIssue(
        'LINK_BROKEN_ANCHOR',
        `Anchor not found: #${resolved.anchor} in ${fileResult.resolvedPath}`,
        linkExtras(link, sourceFilePath, options?.projectRoot, ''),
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
async function validateAnchorLink(
  link: ResourceLink,
  sourceFilePath: string,
  fragmentsByFile: FragmentIndex,
  options?: ValidateLinkOptions,
): Promise<ValidationIssue | null> {
  // Extract anchor (strip leading #)
  const anchor = link.href.startsWith('#') ? link.href.slice(1) : link.href;

  // Validate anchor exists in current file
  const check = checkAnchor(anchor, sourceFilePath, fragmentsByFile, options?.checkHtmlAnchors ?? false);

  switch (check) {
    case 'skip':
    case 'valid':
      return null;
    case 'broken':
      return createRegistryIssue(
        'LINK_BROKEN_ANCHOR',
        `Anchor not found: ${link.href}`,
        linkExtras(link, sourceFilePath, options?.projectRoot, ''),
      );
    default:
      return assertNever(check);
  }
}


/**
 * Verify that the resolved filesystem path exists with the correct case.
 *
 * @param resolvedPath - Absolute filesystem path produced by {@link resolveLocalHref}.
 * @param fsCache - Per-run filesystem lookup memo.
 * @returns Object with exists flag, the path, and optional case-mismatch info.
 */
async function validateResolvedFile(
  resolvedPath: string,
  fsCache: FsLookupCache,
): Promise<{ exists: boolean; resolvedPath: string; actualName?: string; isDirectory: boolean }> {
  const verification = await verifyCaseSensitiveFilename(resolvedPath, fsCache);

  let isDirectory = false;
  if (verification.exists) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolvedPath validated by verifyCaseSensitiveFilename
      const stats = await fs.stat(resolvedPath);
      isDirectory = stats.isDirectory();
    } catch {
      // Stat failed after verifyCaseSensitiveFilename said exists — treat as file.
    }
  }

  const result: { exists: boolean; resolvedPath: string; actualName?: string; isDirectory: boolean } = {
    exists: verification.exists,
    resolvedPath,
    isDirectory,
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

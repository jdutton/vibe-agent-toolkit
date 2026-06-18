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
  isGitIgnored,
  type GitTracker,
  verifyCaseSensitiveFilename,
} from '@vibe-agent-toolkit/utils';

import type { ResourceLink } from './types.js';
import { isWithinProject, issueLocation, resolveLocalHref } from './utils.js';

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
    location: issueLocation(sourceFilePath, projectRoot),
    link: link.href,
    ...(link.line !== undefined && { line: link.line }),
    ...(suggestion !== undefined && { suggestion }),
  };
}

/**
 * Options for link validation.
 */
export interface ValidateLinkOptions {
  /** Project root directory (for git-ignore checking) */
  projectRoot?: string;
  /** Skip git-ignore checks (optimization when checkGitIgnored is false) */
  skipGitIgnoreCheck?: boolean;
  /** Git tracker for efficient git-ignore checking (optional, improves performance) */
  gitTracker?: GitTracker;
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
      return await validateLocalFileLink(link, sourceFilePath, fragmentsByFile, options);

    case 'anchor':
      return await validateAnchorLink(link, sourceFilePath, fragmentsByFile, options?.projectRoot);

    case 'external':
      // External URLs are not validated - don't report them
      return null;

    case 'email':
      // Email links are valid by default
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

  return createRegistryIssue(
    'LINK_BROKEN_FILE',
    `File not found: ${fileResult.resolvedPath}`,
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

  const fileResult = await validateResolvedFile(resolved.resolvedPath);
  const notFound = fileExistenceIssue(fileResult, link, sourceFilePath, options?.projectRoot);
  if (notFound) return notFound;

  if (fileResult.isDirectory) {
    return createRegistryIssue(
      'LINK_BROKEN_FILE',
      `Link target is a directory: ${fileResult.resolvedPath}`,
      linkExtras(
        link,
        sourceFilePath,
        options?.projectRoot,
        'Link to a file inside the directory (e.g., README.md or index.md), or fix the link to point at the intended file.',
      ),
    );
  }

  const gitIgnoreIssue = gitIgnoreSafetyIssue(link, sourceFilePath, fileResult.resolvedPath, options);
  if (gitIgnoreIssue) return gitIgnoreIssue;

  if (resolved.anchor) {
    const check = checkAnchor(resolved.anchor, fileResult.resolvedPath, fragmentsByFile);
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
  projectRoot?: string,
): Promise<ValidationIssue | null> {
  // Extract anchor (strip leading #)
  const anchor = link.href.startsWith('#') ? link.href.slice(1) : link.href;

  // Validate anchor exists in current file
  const check = checkAnchor(anchor, sourceFilePath, fragmentsByFile);

  switch (check) {
    case 'skip':
    case 'valid':
      return null;
    case 'broken':
      return createRegistryIssue(
        'LINK_BROKEN_ANCHOR',
        `Anchor not found: ${link.href}`,
        linkExtras(link, sourceFilePath, projectRoot, ''),
      );
    default:
      return assertNever(check);
  }
}


/**
 * Verify that the resolved filesystem path exists with the correct case.
 *
 * @param resolvedPath - Absolute filesystem path produced by {@link resolveLocalHref}.
 * @returns Object with exists flag, the path, and optional case-mismatch info.
 */
async function validateResolvedFile(
  resolvedPath: string,
): Promise<{ exists: boolean; resolvedPath: string; actualName?: string; isDirectory: boolean }> {
  const verification = await verifyCaseSensitiveFilename(resolvedPath);

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
 * Check whether a fragment exists in the target file's anchor set.
 *
 * - `'skip'`  — target file is not indexed; we cannot prove the anchor is
 *   broken, so callers must not emit an issue.
 * - Matching follows the entry's `caseSensitive` policy (HTML ids exact,
 *   markdown slugs case-folded). The index carries the policy, so this never
 *   re-derives the folding rule from the file extension.
 * - For HTML targets the empty fragment (`#`) and `top` (ASCII
 *   case-insensitive) are always valid: per the HTML fragment-navigation
 *   algorithm both scroll to the top of the document regardless of whether a
 *   matching element exists, so `href="#"` / `href="#top"` are not broken.
 *
 * @param anchor - Fragment without the leading `#`.
 * @param targetFilePath - Absolute path of the file the fragment lives in.
 * @param fragmentsByFile - Fragment index carrying each file's matching policy.
 */
export function checkAnchor(
  anchor: string,
  targetFilePath: string,
  fragmentsByFile: FragmentIndex,
): AnchorCheck {
  const entry = fragmentsByFile.get(targetFilePath);
  if (!entry) {
    return 'skip';
  }
  // HTML spec: the empty fragment and "top" (case-insensitive) always navigate
  // to the top of the document — valid even with no matching id. This is an
  // HTML-format navigation rule, distinct from the case-folding policy above.
  if (isHtmlPath(targetFilePath) && (anchor === '' || anchor.toLowerCase() === 'top')) {
    return 'valid';
  }
  const found = entry.caseSensitive
    ? entry.fragments.has(anchor)
    : entry.fragments.has(anchor.toLowerCase());
  return found ? 'valid' : 'broken';
}

/**
 * Frontmatter URI-reference link validation.
 *
 * For every value in `frontmatter` sitting at a JSON Schema position with a
 * URI-family `format`, classify the value and run local-file references
 * through the existing link-validation engine. Returns issues with
 * frontmatter-specific type codes plus a list of external URLs the registry
 * can fold into its existing external URL collection.
 *
 * Code mapping:
 *   LINK_BROKEN_FILE    -> FRONTMATTER_LINK_BROKEN
 *   LINK_BROKEN_ANCHOR  -> FRONTMATTER_ANCHOR_MISSING
 *   LINK_TO_GITIGNORED  -> FRONTMATTER_LINK_TO_GITIGNORED
 *   LINK_UNKNOWN        -> FRONTMATTER_UNKNOWN_LINK
 *
 * Skipped (no issue, no external):
 *   email (mailto:)
 *   anchor-only (validated as anchor in current file via judgeLink)
 */

import { createRegistryIssue, type IssueCode } from '@vibe-agent-toolkit/agent-schema';
import { fillSiblingNames, FsLookupCache } from '@vibe-agent-toolkit/utils';

import { classifyLink } from './link-parser.js';
import {
  judgeLink,
  judgeOptionsFrom,
  linkTargetPaths,
  resolveLinkEntry,
  type FragmentIndex,
  type ResolvedLinkEntry,
  type ValidateLinkOptions,
} from './link-validator.js';
import { walkFrontmatterUriReferences } from './schema-uri-walker.js';
import type { ResourceLink, ValidationIssue } from './types.js';

/** Map the link-level code emitted by the link judge to its frontmatter-scoped code. */
const LINK_CODE_TO_FRONTMATTER_CODE: Partial<Record<IssueCode, IssueCode>> = {
  LINK_BROKEN_FILE: 'FRONTMATTER_LINK_BROKEN',
  LINK_BROKEN_ANCHOR: 'FRONTMATTER_ANCHOR_MISSING',
  LINK_TO_GITIGNORED: 'FRONTMATTER_LINK_TO_GITIGNORED',
  LINK_UNKNOWN: 'FRONTMATTER_UNKNOWN_LINK',
};

/** A frontmatter-sourced external URL captured for downstream health checking. */
export interface FrontmatterExternalUrl {
  url: string;
  sourcePath: string;
  dottedPath: string;
}

export interface FrontmatterLinkValidationResult {
  issues: ValidationIssue[];
  externalUrls: FrontmatterExternalUrl[];
}

/** A capture that became a resolved link to judge, kept beside the dotted path its issue is reported under. */
interface FrontmatterLinkEntry {
  entry: ResolvedLinkEntry;
  dottedPath: string;
}

/**
 * Validate every URI-family frontmatter value against the file system.
 *
 * Uses the same fill/judge shape as the rest of link validation — classify and
 * resolve every capture (collecting external URLs as it goes), fill the
 * sibling-name table, then judge synchronously — but at a **narrower scope: one
 * fill per file, not one per corpus.** The registry lane fills once for every
 * link in the whole corpus; this function is `await`ed inside a per-resource
 * loop in `resource-registry.ts`, so its fill can only ever see the captures of
 * the file being validated. The shared `fsCache` keeps repeated directories from
 * costing repeated `readdir`s across those per-file fills, but the fills
 * themselves are not batched, and the judge still carries the per-link
 * realpath/`git check-ignore` cost documented on `judgeLink`.
 *
 * Issue order and `externalUrls` order both follow capture order, exactly as the
 * single-pass version did.
 *
 * @param frontmatter - Parsed frontmatter (or undefined)
 * @param schema - JSON Schema for the collection
 * @param sourceFilePath - Absolute path to the source file
 * @param fragmentsByFile - Fragment index (file path → set of valid fragments) for anchor validation
 * @param options - Same shape as validateLink (fsCache, projectRoot, gitTracker, ...)
 */
export async function validateFrontmatterLinks(
  frontmatter: Record<string, unknown> | undefined,
  schema: object,
  sourceFilePath: string,
  fragmentsByFile: FragmentIndex,
  options?: ValidateLinkOptions,
): Promise<FrontmatterLinkValidationResult> {
  if (!frontmatter) return { issues: [], externalUrls: [] };

  const captures = walkFrontmatterUriReferences(frontmatter, schema);
  if (captures.length === 0) return { issues: [], externalUrls: [] };

  const issues: ValidationIssue[] = [];
  const externalUrls: FrontmatterExternalUrl[] = [];
  const entries: FrontmatterLinkEntry[] = [];

  for (const capture of captures) {
    const linkType = classifyLink(capture.value);

    if (linkType === 'external') {
      externalUrls.push({
        url: capture.value,
        sourcePath: sourceFilePath,
        dottedPath: capture.dottedPath,
      });
      continue;
    }
    if (linkType === 'email') continue;

    const link: ResourceLink = {
      text: capture.dottedPath,
      href: capture.value,
      type: linkType,
      line: 1, // Frontmatter per-field line numbers are post-v1.
    };

    entries.push({
      entry: resolveLinkEntry({ link, sourceFilePath }, options?.projectRoot),
      dottedPath: capture.dottedPath,
    });
  }

  // One fill for this file's frontmatter references. The fill set is read off
  // the very resolution objects the judge will read — see linkTargetPaths.
  const siblingNames = await fillSiblingNames(
    linkTargetPaths(entries.map(({ entry }) => entry)),
    options?.fsCache ?? new FsLookupCache(),
  );
  const judgeOptions = judgeOptionsFrom(options, siblingNames);

  for (const { entry, dottedPath } of entries) {
    const issue = judgeLink(entry, fragmentsByFile, judgeOptions);
    if (!issue) continue;

    issues.push(rewriteIssue(issue, dottedPath));
  }

  return { issues, externalUrls };
}

function rewriteIssue(issue: ValidationIssue, dottedPath: string): ValidationIssue {
  const mappedCode = LINK_CODE_TO_FRONTMATTER_CODE[issue.code as IssueCode] ?? (issue.code as IssueCode);
  const message = `field \`${dottedPath}\`: ${issue.message}`;
  const extras: Partial<Pick<ValidationIssue, 'location' | 'line' | 'link' | 'suggestion'>> = {};
  if (issue.location !== undefined) extras.location = issue.location;
  if (issue.line !== undefined) extras.line = issue.line;
  if (issue.link !== undefined) extras.link = issue.link;
  if (issue.suggestion !== undefined) extras.suggestion = issue.suggestion;
  return createRegistryIssue(mappedCode, message, extras);
}

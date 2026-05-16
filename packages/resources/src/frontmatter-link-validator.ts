/**
 * Frontmatter URI-reference link validation.
 *
 * For every value in `frontmatter` sitting at a JSON Schema position with a
 * URI-family `format`, classify the value and run local-file references
 * through the existing `validateLink` engine. Returns issues with
 * frontmatter-specific type codes plus a list of external URLs the registry
 * can fold into its existing external URL collection.
 *
 * Type mapping:
 *   broken_file        -> frontmatter_link_broken
 *   broken_anchor      -> frontmatter_anchor_missing
 *   link_to_gitignored -> frontmatter_link_to_gitignored
 *   unknown_link       -> frontmatter_unknown_link
 *
 * Skipped (no issue, no external):
 *   email (mailto:)
 *   anchor-only (validated as anchor in current file via validateLink)
 */

import { classifyLink } from './link-parser.js';
import { validateLink, type ValidateLinkOptions } from './link-validator.js';
import { walkFrontmatterUriReferences } from './schema-uri-walker.js';
import type { HeadingNode, ResourceLink, ValidationIssue } from './types.js';

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

/**
 * Validate every URI-family frontmatter value against the file system.
 *
 * @param frontmatter - Parsed frontmatter (or undefined)
 * @param schema - JSON Schema for the collection
 * @param sourceFilePath - Absolute path to the source file
 * @param headingsByFile - Heading trees (for anchor validation)
 * @param options - Same shape as validateLink (projectRoot, gitTracker, ...)
 */
export async function validateFrontmatterLinks(
  frontmatter: Record<string, unknown> | undefined,
  schema: object,
  sourceFilePath: string,
  headingsByFile: Map<string, HeadingNode[]>,
  options?: ValidateLinkOptions,
): Promise<FrontmatterLinkValidationResult> {
  if (!frontmatter) return { issues: [], externalUrls: [] };

  const captures = walkFrontmatterUriReferences(frontmatter, schema);
  if (captures.length === 0) return { issues: [], externalUrls: [] };

  const issues: ValidationIssue[] = [];
  const externalUrls: FrontmatterExternalUrl[] = [];

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

    const syntheticLink: ResourceLink = {
      text: capture.dottedPath,
      href: capture.value,
      type: linkType,
      line: 1, // Frontmatter per-field line numbers are post-v1.
    };

    const issue = await validateLink(syntheticLink, sourceFilePath, headingsByFile, options);
    if (!issue) continue;

    issues.push(rewriteIssue(issue, capture.dottedPath));
  }

  return { issues, externalUrls };
}

function rewriteIssue(issue: ValidationIssue, dottedPath: string): ValidationIssue {
  return {
    ...issue,
    type: mapType(issue.type),
    message: `field \`${dottedPath}\`: ${issue.message}`,
  };
}

function mapType(originalType: string): string {
  switch (originalType) {
    case 'broken_file':
      return 'frontmatter_link_broken';
    case 'broken_anchor':
      return 'frontmatter_anchor_missing';
    case 'link_to_gitignored':
      return 'frontmatter_link_to_gitignored';
    case 'unknown_link':
      return 'frontmatter_unknown_link';
    default:
      return originalType;
  }
}

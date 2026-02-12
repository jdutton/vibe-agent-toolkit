/**
 * Content transform engine for rewriting markdown links.
 *
 * Provides a pure function for transforming markdown link references
 * based on configurable rules. Used by both RAG (rewriting links before
 * persistence) and agent-skills (rewriting links during skill packaging).
 *
 * @example
 * ```typescript
 * import { transformContent, type LinkRewriteRule } from '@vibe-agent-toolkit/resources';
 *
 * const rules: LinkRewriteRule[] = [
 *   {
 *     match: { type: 'local_file' },
 *     template: '{{link.text}} (see: {{link.resource.id}})',
 *   },
 * ];
 *
 * const result = transformContent(content, links, { linkRewriteRules: rules, resourceRegistry: registry });
 * ```
 */

import path from 'node:path';

import { renderTemplate, toForwardSlash } from '@vibe-agent-toolkit/utils';

import type { LinkType, ResourceLink, ResourceMetadata } from './schemas/resource-metadata.js';
import { matchesGlobPattern, splitHrefAnchor } from './utils.js';

/**
 * Extension-to-MIME-type mapping for common resource file types.
 */
const EXTENSION_MIME_MAP: Record<string, string> = {
  '.md': 'text/markdown',
  '.ts': 'text/typescript',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.txt': 'text/plain',
};

/**
 * Default MIME type when the file extension is unknown.
 */
const DEFAULT_MIME_TYPE = 'application/octet-stream';

/**
 * Infer MIME type from a file extension.
 *
 * @param filePath - File path to extract extension from
 * @returns Inferred MIME type string
 */
function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? DEFAULT_MIME_TYPE;
}

/**
 * Interface for looking up resources by ID.
 *
 * Intentionally minimal to avoid tight coupling to ResourceRegistry.
 * Any object providing `getResourceById` satisfies this contract.
 */
export interface ResourceLookup {
  /** Look up a resource by its unique ID */
  getResourceById(id: string): ResourceMetadata | undefined;
}

/**
 * Match criteria for a link rewrite rule.
 *
 * A rule matches a link when ALL specified criteria are satisfied:
 * - `type`: Link type matches (if specified)
 * - `pattern`: Target resource's filePath matches a glob pattern (if specified)
 * - `excludeResourceIds`: Target resource's ID is NOT in the exclusion list
 */
export interface LinkRewriteMatch {
  /**
   * Link type(s) to match. If omitted, matches any type.
   * Can be a single LinkType or an array of LinkType values.
   */
  type?: LinkType | LinkType[];

  /**
   * Glob pattern(s) to match against the target resource's filePath.
   * If omitted, matches any path. Requires the link to have a resolvedId
   * so the target resource can be looked up.
   * Can be a single glob string or an array of glob strings.
   */
  pattern?: string | string[];

  /**
   * Resource IDs to exclude from matching.
   * If the link's resolvedId is in this list, the rule does not match.
   */
  excludeResourceIds?: string[];
}

/**
 * A rule for rewriting markdown links in content.
 *
 * Rules are evaluated in order; the first matching rule wins.
 * Links that match no rule are left untouched.
 */
export interface LinkRewriteRule {
  /**
   * Match criteria. All specified criteria must be satisfied for the rule to match.
   */
  match: LinkRewriteMatch;

  /**
   * Handlebars template for the replacement text.
   *
   * Available template variables:
   * - `link.text` - Link display text
   * - `link.href` - Original href (without fragment)
   * - `link.fragment` - Fragment portion including `#` prefix (or empty string)
   * - `link.type` - Link type (local_file, anchor, external, email, unknown)
   * - `link.resource.id` - Target resource ID (if resolved)
   * - `link.resource.filePath` - Target resource file path (if resolved)
   * - `link.resource.fileName` - Target resource file name with extension (if resolved)
   * - `link.resource.extension` - Target resource file extension (if resolved)
   * - `link.resource.mimeType` - Inferred MIME type (if resolved)
   * - `link.resource.frontmatter.*` - Target resource frontmatter fields (if resolved)
   * - `link.resource.sizeBytes` - Target resource size in bytes (if resolved)
   * - `link.resource.estimatedTokenCount` - Target resource estimated token count (if resolved)
   * - `link.resource.relativePath` - Relative path from sourceFilePath to resource (if both available)
   * - Plus any variables from `context`
   */
  template: string;
}

/**
 * Options for the `transformContent` function.
 */
export interface ContentTransformOptions {
  /** Ordered list of link rewrite rules. First matching rule wins. */
  linkRewriteRules: LinkRewriteRule[];

  /**
   * Resource lookup for resolving `link.resource.*` template variables.
   * If not provided, `link.resource.*` variables will be undefined in templates.
   */
  resourceRegistry?: ResourceLookup;

  /**
   * Additional context variables available in all templates.
   * These are merged at the top level of the template context.
   */
  context?: Record<string, unknown>;

  /**
   * Absolute file path of the source document being transformed.
   * When provided, enables `link.resource.relativePath` computation:
   * `relative(dirname(sourceFilePath), link.resource.filePath)` using forward slashes.
   */
  sourceFilePath?: string;

  /**
   * Fallback template for links that match no rule.
   * Without this option, unmatched links are left untouched (original markdown preserved).
   * With this option, unmatched links are rendered through this template.
   */
  defaultTemplate?: string;
}

/**
 * Build the template context for a matched link.
 *
 * @param link - The ResourceLink being transformed
 * @param hrefWithoutFragment - The href with fragment stripped
 * @param fragment - The fragment string including '#' prefix, or empty string
 * @param resource - The resolved target resource (if available)
 * @param extraContext - Additional context variables
 * @param sourceFilePath - Absolute path of the source document (for relativePath computation)
 * @returns Template context object
 */
function buildTemplateContext(
  link: ResourceLink,
  hrefWithoutFragment: string,
  fragment: string,
  resource: ResourceMetadata | undefined,
  extraContext: Record<string, unknown> | undefined,
  sourceFilePath: string | undefined,
): Record<string, unknown> {
  const resourceContext = resource === undefined
    ? undefined
    : {
        id: resource.id,
        filePath: resource.filePath,
        fileName: path.basename(resource.filePath),
        extension: path.extname(resource.filePath),
        mimeType: inferMimeType(resource.filePath),
        frontmatter: resource.frontmatter,
        sizeBytes: resource.sizeBytes,
        estimatedTokenCount: resource.estimatedTokenCount,
        relativePath: sourceFilePath === undefined
          ? undefined
          : toForwardSlash(path.relative(path.dirname(sourceFilePath), resource.filePath)),
      };

  return {
    ...extraContext,
    link: {
      text: link.text,
      href: hrefWithoutFragment,
      fragment,
      type: link.type,
      resource: resourceContext,
    },
  };
}

/**
 * Check if a link's type matches the rule's type criteria.
 *
 * @param linkType - The link's type
 * @param matchType - The rule's type criteria (single or array, or undefined = match all)
 * @returns True if the type matches
 */
function matchesType(linkType: LinkType, matchType: LinkType | LinkType[] | undefined): boolean {
  if (matchType === undefined) {
    return true;
  }
  if (Array.isArray(matchType)) {
    return matchType.includes(linkType);
  }
  return linkType === matchType;
}

/**
 * Check if a link's target resource matches the rule's pattern criteria.
 *
 * @param resource - The target resource (if resolved)
 * @param patterns - The pattern(s) to match against (or undefined = match all)
 * @returns True if the pattern matches or no pattern is specified
 */
function matchesPattern(
  resource: ResourceMetadata | undefined,
  patterns: string | string[] | undefined,
): boolean {
  if (patterns === undefined) {
    return true;
  }

  // Pattern matching requires a resolved resource
  if (resource === undefined) {
    return false;
  }

  const patternArray = Array.isArray(patterns) ? patterns : [patterns];
  return patternArray.some((pattern) => matchesGlobPattern(resource.filePath, pattern));
}

/**
 * Check if a link's resolvedId is excluded by the rule.
 *
 * @param resolvedId - The link's resolved resource ID (if any)
 * @param excludeResourceIds - IDs to exclude (if any)
 * @returns True if the link is excluded (should NOT match)
 */
function isExcluded(
  resolvedId: string | undefined,
  excludeResourceIds: string[] | undefined,
): boolean {
  if (excludeResourceIds === undefined || excludeResourceIds.length === 0) {
    return false;
  }
  if (resolvedId === undefined) {
    return false;
  }
  return excludeResourceIds.includes(resolvedId);
}

/**
 * Find the first matching rule for a given link.
 *
 * @param link - The ResourceLink to match
 * @param resource - The resolved target resource (if available)
 * @param rules - Ordered list of rules
 * @returns The first matching rule, or undefined if no rule matches
 */
function findMatchingRule(
  link: ResourceLink,
  resource: ResourceMetadata | undefined,
  rules: LinkRewriteRule[],
): LinkRewriteRule | undefined {
  for (const rule of rules) {
    const { match } = rule;

    if (!matchesType(link.type, match.type)) {
      continue;
    }

    if (!matchesPattern(resource, match.pattern)) {
      continue;
    }

    if (isExcluded(link.resolvedId, match.excludeResourceIds)) {
      continue;
    }

    return rule;
  }

  return undefined;
}

/**
 * Regex pattern matching inline markdown links: `[text](href)`
 *
 * Captures:
 * - Group 0: Full match including brackets and parentheses
 * - Group 1: Link text
 * - Group 2: Link href
 *
 * Does NOT handle nested brackets in link text — the negated character class
 * `[^\]]*` excludes `]` characters, so `[text [with] brackets](href)` would
 * not be matched as a single link.
 */
// eslint-disable-next-line sonarjs/slow-regex -- negated character classes [^\]] and [^)] are inherently non-backtracking
const MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\(([^)]*)\)/g;

/**
 * Regex pattern matching reference-style link definitions: `[ref]: url`
 *
 * Must appear at the start of a line (multiline flag).
 * Captures:
 * - Group 1: Reference identifier
 * - Group 2: URL (may include trailing whitespace)
 */
// eslint-disable-next-line sonarjs/slow-regex -- Controlled markdown reference link definitions on line boundaries
const MARKDOWN_DEFINITION_REGEX = /^\[([^\]]*?)\]:\s*(.+)$/gm;

/**
 * Transform markdown content by rewriting links according to rules.
 *
 * This is a pure function that takes content, its parsed links, and transform options,
 * and returns the content with matching links rewritten according to the first matching rule.
 *
 * Two passes are performed:
 * 1. **Inline links** `[text](href)` — matched via rules, rendered through templates
 * 2. **Definition lines** `[ref]: url` — matched via rules, rewritten in definition format
 *    or removed if orphaned (target not in registry)
 *
 * Links matching no rule are left untouched unless a `defaultTemplate` is provided.
 *
 * @param content - The markdown content to transform
 * @param links - Parsed links from the content (from ResourceMetadata.links)
 * @param options - Transform options including rules, registry, and context
 * @returns The transformed content with rewritten links
 *
 * @example
 * ```typescript
 * const rules: LinkRewriteRule[] = [
 *   {
 *     match: { type: 'local_file' },
 *     template: '{{link.text}} (ref: {{link.resource.id}})',
 *   },
 *   {
 *     match: { type: 'external' },
 *     template: '[{{link.text}}]({{link.href}})',
 *   },
 * ];
 *
 * const result = transformContent(content, resource.links, {
 *   linkRewriteRules: rules,
 *   resourceRegistry: registry,
 * });
 * ```
 */
export function transformContent(
  content: string,
  links: ResourceLink[],
  options: ContentTransformOptions,
): string {
  const { linkRewriteRules, resourceRegistry, context, sourceFilePath, defaultTemplate } = options;

  // If there are no rules, no default template, or no links, return content unchanged
  if ((linkRewriteRules.length === 0 && defaultTemplate === undefined) || links.length === 0) {
    return content;
  }

  // === Pass 1: Inline links [text](href) ===

  // Build a lookup map from "[text](href)" to the corresponding ResourceLink.
  // Multiple links can share the same text+href combination; we process them all
  // with the first matching ResourceLink (they are identical in terms of match criteria).
  const linkBySignature = new Map<string, ResourceLink>();
  for (const link of links) {
    if (link.nodeType === 'definition') {
      continue; // Definitions are handled in pass 2
    }
    const signature = `[${link.text}](${link.href})`;
    if (!linkBySignature.has(signature)) {
      linkBySignature.set(signature, link);
    }
  }

  // Replace inline markdown links in content
  let result = content.replaceAll(MARKDOWN_LINK_REGEX, (fullMatch, text: string, href: string) => {
    // Find the corresponding ResourceLink
    const signature = `[${text}](${href})`;
    const link = linkBySignature.get(signature);

    if (!link) {
      // Link not in the parsed links array - leave untouched
      return fullMatch;
    }

    // Resolve the target resource if available
    const resource = link.resolvedId === undefined || resourceRegistry === undefined
      ? undefined
      : resourceRegistry.getResourceById(link.resolvedId);

    // Find the first matching rule
    const rule = findMatchingRule(link, resource, linkRewriteRules);

    // Determine which template to use: matched rule, defaultTemplate, or leave untouched
    const template = rule?.template ?? defaultTemplate;
    if (template === undefined) {
      // No rule matches and no default template - leave untouched
      return fullMatch;
    }

    // Parse fragment from href
    const [hrefWithoutFragment, anchor] = splitHrefAnchor(href);
    const fragment = anchor === undefined ? '' : `#${anchor}`;

    // Build template context and render
    const templateContext = buildTemplateContext(link, hrefWithoutFragment, fragment, resource, context, sourceFilePath);
    return renderTemplate(template, templateContext);
  });

  // === Pass 2: Reference-style definitions [ref]: url ===

  // Build lookup map for definition links (keyed by "identifier\0href")
  const definitionByKey = new Map<string, ResourceLink>();
  for (const link of links) {
    if (link.nodeType !== 'definition') {
      continue;
    }
    const key = `${link.text}\0${link.href}`;
    if (!definitionByKey.has(key)) {
      definitionByKey.set(key, link);
    }
  }

  if (definitionByKey.size > 0) {
    result = result.replaceAll(
      MARKDOWN_DEFINITION_REGEX,
      (fullMatch, ref: string, href: string) => {
        const trimmedHref = href.trim();

        // Look up the corresponding definition ResourceLink
        const key = `${ref}\0${trimmedHref}`;
        const link = definitionByKey.get(key);
        if (!link) {
          return fullMatch;
        }

        // Resolve the target resource if available
        const resource = link.resolvedId === undefined || resourceRegistry === undefined
          ? undefined
          : resourceRegistry.getResourceById(link.resolvedId);

        // Find matching rule (same rule set as inline links)
        const rule = findMatchingRule(link, resource, linkRewriteRules);
        const template = rule?.template ?? defaultTemplate;

        if (template === undefined) {
          return fullMatch;
        }

        // If resource is in registry and we have sourceFilePath: rewrite URL in definition format
        if (resource !== undefined && sourceFilePath !== undefined) {
          const [, anchor] = splitHrefAnchor(trimmedHref);
          const fragment = anchor === undefined ? '' : `#${anchor}`;
          const newRelPath = toForwardSlash(
            path.relative(path.dirname(sourceFilePath), resource.filePath),
          );
          return `[${ref}]: ${newRelPath}${fragment}`;
        }

        // Rule matched but no resource to rewrite to — remove orphaned definition
        return '';
      },
    );

    // Clean up excessive blank lines from removed definitions
    result = result.replaceAll(/\n{3,}/g, '\n\n');
  }

  return result;
}

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

import { toForwardSlash, safePath } from '@vibe-agent-toolkit/utils';

import { renderHandlebarsTemplate } from './handlebars-template.js';
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
 * - `pattern`: Target file path matches a glob pattern (if specified)
 * - `excludeResourceIds`: Target resource's ID is NOT in the exclusion list
 */
export interface LinkRewriteMatch {
  /**
   * Link type(s) to match. If omitted, matches any type.
   * Can be a single LinkType or an array of LinkType values.
   */
  type?: LinkType | LinkType[];

  /**
   * Glob pattern(s) to match against the target file path.
   *
   * For resolved links (target resource found in the registry), patterns match
   * against `resource.filePath`. For unresolved links (e.g., terminal links to
   * non-markdown files not indexed by the registry), patterns fall back to
   * matching against the link's raw href. This allows exclude rules to apply
   * to assets like YAML, JSON, or images that markdown files reference.
   *
   * If omitted, matches any path.
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
 * @param rawText - Raw markdown text between the `[` and `]` (with inline formatting preserved).
 *   When omitted, `link.rawText` falls back to `link.text`.
 * @returns Template context object
 */
function buildTemplateContext(
  link: ResourceLink,
  hrefWithoutFragment: string,
  fragment: string,
  resource: ResourceMetadata | undefined,
  extraContext: Record<string, unknown> | undefined,
  sourceFilePath: string | undefined,
  rawText: string | undefined,
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
          : toForwardSlash(safePath.relative(path.dirname(sourceFilePath), resource.filePath)),
      };

  return {
    ...extraContext,
    link: {
      text: link.text,
      rawText: rawText ?? link.text,
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
 * Check if a link's target file path matches the rule's pattern criteria.
 *
 * Uses `resource.filePath` when the link is resolved. Falls back to the link's
 * href (anchor stripped) for unresolved links so rules can target terminal
 * assets — YAML, JSON, images — that the registry does not index.
 *
 * @param link - The link being tested
 * @param resource - The target resource (if resolved)
 * @param patterns - The pattern(s) to match against (or undefined = match all)
 * @returns True if the pattern matches or no pattern is specified
 */
function matchesPattern(
  link: ResourceLink,
  resource: ResourceMetadata | undefined,
  patterns: string | string[] | undefined,
): boolean {
  if (patterns === undefined) {
    return true;
  }

  let pathToMatch: string;
  if (resource === undefined) {
    const [hrefWithoutAnchor] = splitHrefAnchor(link.href);
    if (hrefWithoutAnchor === '') {
      return false;
    }
    pathToMatch = hrefWithoutAnchor;
  } else {
    pathToMatch = resource.filePath;
  }

  const patternArray = Array.isArray(patterns) ? patterns : [patterns];
  return patternArray.some((pattern) => matchesGlobPattern(pathToMatch, pattern));
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

    if (!matchesPattern(link, resource, match.pattern)) {
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
 * excludes BOTH `[` and `]`, so `[text [with] brackets](href)` is not matched as
 * a single link.
 *
 * Excluding `[` (not just `]`) is what keeps the match ANCHORED to the real link.
 * With `[^\]]*`, a stray unpaired `[` earlier in the line — most often one inside
 * inline code, e.g. a sentence listing glob metacharacters ``(`*`, `**`, `?`, `[`)``
 * — starts a match that runs forward to the NEXT link's `](`, swallowing every
 * character between them into the link text. The rewritten replacement then stands
 * in for that whole span, so a template that does not re-emit the text verbatim
 * DELETES the intervening prose from the packaged file. Requiring the text to be
 * bracket-free makes the scan resume at the genuine `[`.
 */
const MARKDOWN_LINK_REGEX = /\[([^[\]]*)\]\(([^)]*)\)/g;

/** A fence opener/closer: up to 3 spaces of indent, then 3+ backticks or tildes. */
const FENCE_LINE_REGEX = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Byte ranges of `content` that are CODE, not prose — link syntax inside them is
 * an EXAMPLE and must survive packaging verbatim.
 *
 * The rewrite pass replays a raw regex over the whole document, while the parsed
 * link list comes from mdast, which never yields a link node for fenced or inline
 * code. Those two views agree only by accident: a fenced ``[Guide](refs/guide.md)``
 * is skipped merely because no parsed link claims that href. Let a REAL link
 * elsewhere in the file point at the same target and the href lookup hits, so a
 * skill teaching authored link syntax shipped the packaged path instead of the one
 * a reader must type — or, for a target that does not ship, stripped the example to
 * bare text. Masking the ranges makes the skip intentional.
 *
 * Deliberately a LINEAR scan rather than one regex over the whole document. The
 * obvious pattern for "fence, lazily anything, matching fence" nests quantifiers
 * and backtracks super-linearly on unclosed or near-miss fences — and this runs
 * over every packaged markdown file, including adopter content VAT does not
 * control. This walks each line once and each backtick run once.
 */
function codeSpanRanges(content: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let offset = 0;
  let fence: { char: string; len: number; start: number } | undefined;

  for (const line of content.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1; // +1 for the '\n' that split consumed
    const marker = FENCE_LINE_REGEX.exec(line)?.[1];

    if (fence === undefined) {
      if (marker === undefined) {
        collectInlineSpans(line, lineStart, ranges);
      } else {
        fence = { char: marker[0] as string, len: marker.length, start: lineStart };
      }
      continue;
    }
    // A closer must use the same character and be at least as long as the opener.
    if (marker?.[0] === fence.char && marker.length >= fence.len) {
      ranges.push([fence.start, lineStart + line.length]);
      fence = undefined;
    }
  }
  // An unclosed fence runs to end of document — CommonMark closes it implicitly.
  if (fence !== undefined) ranges.push([fence.start, content.length]);
  return ranges;
}

/**
 * Append every inline code span on one line. A span is a run of N backticks closed
 * by the next run of EXACTLY N, per CommonMark.
 */
function collectInlineSpans(line: string, base: number, ranges: Array<readonly [number, number]>): void {
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      i += 1;
      continue;
    }
    const openStart = i;
    i = endOfBacktickRun(line, i);
    const closeEnd = findClosingRun(line, i, i - openStart);
    if (closeEnd === undefined) continue; // unclosed: prose, resume after the run
    ranges.push([base + openStart, base + closeEnd]);
    i = closeEnd;
  }
}

/** Index just past the backtick run starting at `from`. */
function endOfBacktickRun(line: string, from: number): number {
  let i = from;
  while (i < line.length && line[i] === '`') i += 1;
  return i;
}

/** End index of the next backtick run of EXACTLY `len`, or undefined if none. */
function findClosingRun(line: string, from: number, len: number): number | undefined {
  let j = from;
  while (j < line.length) {
    if (line[j] !== '`') {
      j += 1;
      continue;
    }
    const start = j;
    j = endOfBacktickRun(line, j);
    if (j - start === len) return j;
  }
  return undefined;
}

/** True when `offset` falls inside any masked code range. */
function isInsideCode(offset: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

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

  // Build a lookup map keyed by href → ResourceLink. We intentionally key by href
  // rather than "[text](href)" because the regex below captures the RAW markdown
  // text (including backticks, emphasis markers, etc.), while `link.text` is
  // already rendered (formatting stripped). Keying by text causes a signature
  // mismatch for any formatted link text; keying by href avoids that class of
  // bug entirely. When multiple inline links share an href, the first wins —
  // their match criteria (type, resolvedId) are identical for lookup purposes.
  const linkByHref = new Map<string, ResourceLink>();
  for (const link of links) {
    if (link.nodeType === 'definition') {
      continue; // Definitions are handled in pass 2
    }
    if (!linkByHref.has(link.href)) {
      linkByHref.set(link.href, link);
    }
  }

  // Ranges to leave alone: link syntax inside code is an example, not a link.
  const codeRanges = codeSpanRanges(content);

  // Replace inline markdown links in content
  let result = content.replaceAll(MARKDOWN_LINK_REGEX, (fullMatch, rawText: string, href: string, offset: number) => {
    if (isInsideCode(offset, codeRanges)) return fullMatch;

    // Find the corresponding ResourceLink by href
    const link = linkByHref.get(href);

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

    // Build template context and render. rawText preserves any inline
    // formatting the author wrote (backticks, bold, italics) so templates
    // targeting bundled links can render the link with original styling.
    const templateContext = buildTemplateContext(link, hrefWithoutFragment, fragment, resource, context, sourceFilePath, rawText);
    return renderHandlebarsTemplate(template, templateContext);
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
      (fullMatch, ref: string, href: string, offset: number) => {
        if (isInsideCode(offset, codeRanges)) return fullMatch;
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
            safePath.relative(path.dirname(sourceFilePath), resource.filePath),
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

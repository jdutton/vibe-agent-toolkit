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
 * ⚠️ **This is the FALLBACK path, not the primary one.** Pass 1 splices links at
 * the spans the parser reported (see {@link SplicableLink}); this regex now runs
 * only over the stretches between those spans, and only on behalf of links the
 * parser could not locate. Its grammar quirks below are therefore about not
 * corrupting prose, not about identifying links correctly — the parser does that.
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

/** An ATX heading line, which interrupts a paragraph. See {@link breaksParagraph}. */
const ATX_HEADING_LINE_REGEX = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/**
 * Byte ranges of `content` that are CODE, not prose — link syntax inside them is
 * an EXAMPLE and must survive packaging verbatim.
 *
 * These exist for the FALLBACK replay only, and are kept rather than deleted.
 * Pass 1 splices at parser-reported spans, and mdast never yields a link node for
 * fenced or inline code, so an example is not a splice target at all — the primary
 * path is safe structurally and needs no mask. {@link replayUnsplicable} still
 * replays a raw regex over the gaps on behalf of links the parser could not locate,
 * and that replay has the original exposure: a fenced ``[Guide](refs/guide.md)``
 * would be skipped merely because no parsed link claims that href, so a REAL link
 * elsewhere in the file pointing at the same target makes the lookup HIT — and a
 * skill teaching authored link syntax ships the packaged path instead of the one a
 * reader must type, or, for a target that does not ship, gets stripped to bare
 * text. Masking the ranges keeps that skip intentional on the path that still
 * needs it.
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
  // The paragraph being accumulated, as a span of `content`. Inline spans are
  // collected per PARAGRAPH, not per line: see {@link endOfParagraph}.
  let paragraphStart: number | undefined;
  const flushParagraph = (end: number): void => {
    if (paragraphStart !== undefined) collectInlineSpans(content.slice(paragraphStart, end), paragraphStart, ranges);
    paragraphStart = undefined;
  };

  for (const line of content.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1; // +1 for the '\n' that split consumed
    const marker = FENCE_LINE_REGEX.exec(line)?.[1];

    if (fence === undefined) {
      if (marker !== undefined) {
        flushParagraph(lineStart);
        fence = { char: marker[0] as string, len: marker.length, start: lineStart };
      } else if (breaksParagraph(line)) {
        flushParagraph(lineStart);
      } else {
        paragraphStart ??= lineStart;
      }
      continue;
    }
    // A closer must use the same character and be at least as long as the opener.
    if (marker?.[0] === fence.char && marker.length >= fence.len) {
      ranges.push([fence.start, lineStart + line.length]);
      fence = undefined;
    }
  }
  flushParagraph(content.length);
  // An unclosed fence runs to end of document — CommonMark closes it implicitly.
  if (fence !== undefined) ranges.push([fence.start, content.length]);
  return ranges;
}

/**
 * Append every inline code span in one paragraph. A span is a run of N backticks
 * closed by the next run of EXACTLY N, per CommonMark.
 *
 * Shares its two rules with {@link matchingBracketEnd} rather than carrying its
 * own: a backslash escapes the next character (so `` \` `` opens nothing), and a
 * span is closed by {@link codeSpanEnd} or it is prose. Two scanners disagreeing
 * about where a code span is — measured, on exactly the escaped backtick — is the
 * divergence this module exists to stop repeating.
 */
function collectInlineSpans(text: string, base: number, ranges: Array<readonly [number, number]>): void {
  let i = 0;
  while (i < text.length) {
    const character = text.charAt(i);
    if (character === '\\') {
      i += 2;
      continue;
    }
    if (character !== '`') {
      i += 1;
      continue;
    }
    const closeEnd = codeSpanEnd(text, i, text.length);
    if (closeEnd === undefined) {
      i = endOfBacktickRun(text, i); // unclosed: prose, resume after the run
      continue;
    }
    ranges.push([base + i, base + closeEnd]);
    i = closeEnd;
  }
}

/** Index just past the backtick run starting at `from`. */
function endOfBacktickRun(text: string, from: number): number {
  let i = from;
  while (i < text.length && text[i] === '`') i += 1;
  return i;
}

/**
 * End index of the next backtick run of EXACTLY `len` before `limit`, or
 * undefined if none.
 *
 * `limit` is the end of the paragraph, because a code span does not cross one;
 * {@link matchingBracketEnd} calls this with the WHOLE document, and
 * {@link collectInlineSpans} with one already-isolated paragraph.
 */
function findClosingRun(text: string, from: number, len: number, limit: number): number | undefined {
  let j = from;
  while (j < limit) {
    if (text[j] !== '`') {
      j += 1;
      continue;
    }
    const start = j;
    j = endOfBacktickRun(text, j);
    if (j - start === len) return j;
  }
  return undefined;
}

/**
 * A line that ends the paragraph before it: blank, a fence, or an ATX heading.
 *
 * These are the paragraph interrupters that carry backticks in practice. The
 * others CommonMark defines (a list item, a block quote, a thematic break) are
 * not modelled, and the cost of that is bounded in the safe direction: a span
 * wrongly extended into one of them can only make {@link matchingBracketEnd}
 * REFUSE a link (its `close` lands past the parser's span), never splice it.
 */
function breaksParagraph(line: string): boolean {
  return line.trim() === '' || FENCE_LINE_REGEX.test(line) || ATX_HEADING_LINE_REGEX.test(line);
}

/**
 * Index of the newline ending the paragraph containing `from`, or the end of
 * `text`.
 *
 * 🚨 A PARAGRAPH, not a line. A CommonMark code span crosses a single line ending
 * (it is rendered as a space) and stops only at the end of its paragraph, so
 * bounding the closing-run search at the newline refused every link whose code
 * span wrapped at a soft break — prose reflowed to 80 columns does that without
 * anyone writing it — and the link then shipped unrewritten and was reported as
 * PACKAGED_BROKEN_LINK, the symptom the code-span fix was made for, one
 * line-break over.
 */
function endOfParagraph(text: string, from: number): number {
  let newline = text.indexOf('\n', from);
  while (newline !== -1) {
    const next = text.indexOf('\n', newline + 1);
    if (breaksParagraph(text.slice(newline + 1, next === -1 ? text.length : next))) return newline;
    newline = next;
  }
  return text.length;
}

/**
 * Index just past the code span opening at `from`, or undefined when nothing
 * closes it before `limit` — an unclosed run is literal prose, so a caller must
 * resume immediately after the run rather than swallow the rest of the paragraph.
 *
 * `limit` is passed in rather than derived: the caller already has it and
 * recomputing the paragraph end per backtick would make a run of N backticks
 * cost O(N²).
 */
function codeSpanEnd(text: string, from: number, limit: number): number | undefined {
  const runEnd = endOfBacktickRun(text, from);
  return findClosingRun(text, runEnd, runEnd - from, limit);
}

/** True when `offset` falls inside any masked code range. */
function isInsideCode(offset: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

/**
 * A run of three or more line endings, of either flavour, left by a removed
 * definition.
 *
 * ⚠️ Matches `\r\n` as one ending rather than counting the `\n`s: the previous
 * `/\n{3,}/` could not match `\r\n\r\n\r\n` at all, so a CRLF file kept every
 * blank line an LF file had cleaned up.
 *
 * 🚨 Applied ONLY to the run around a removal, never to the whole document. It
 * used to run over the entire result whenever any definition existed, code
 * fences included — so a fenced Python example carrying PEP 8's two blank lines
 * between top-level defs shipped with one, and a deliberate run in prose was
 * "tidied" by a pass that had removed nothing near it. A rewriter returns the
 * file it was given with the intended edit applied; the only blank lines it may
 * touch are the ones its own edit created. See {@link collapseBlankRunAt}.
 */
const BLANK_LINE_RUN_REGEX = /(?:\r\n|\n){3,}/g;

/**
 * A parsed link the source locates precisely enough to rewrite by SPLICING its
 * own span, rather than by replaying a regex and correlating on href.
 *
 * ## Why splicing, and not the href correlation this module used to do
 *
 * `MARKDOWN_LINK_REGEX` and mdast do not agree on what a link is. On
 * `[![alt](img.png)](url)` the regex matches the INNER image href while mdast
 * reports only the OUTER link — so the href lookup missed, the rewriter took its
 * "not in the parsed links array, leave untouched" branch, and **a link the
 * registry had fully resolved was silently never rewritten**, shipping a wrong
 * link in the packaged skill. Correlating two grammars by a value they disagree
 * about cannot be made correct; the parsed view's own `[startOffset, endOffset)`
 * is the only thing that names the construct unambiguously.
 *
 * Splicing also removes a latent hazard rather than merely working around it: a
 * fenced or code-span EXAMPLE that happens to share an href with a real link used
 * to be spared only because {@link codeSpanRanges} masked it. mdast yields no link
 * node inside code at all, so a spliced pass never sees the example in the first
 * place. The masking is retained for the fallback path below, which still replays
 * the regex.
 */
interface SplicableLink {
  readonly link: ResourceLink;
  readonly start: number;
  readonly end: number;
  /** Raw markdown between the construct's outer `[` and its matching `]`. */
  readonly rawText: string;
}

/**
 * What {@link splicableFrom} concluded about one link's span.
 *
 * 🚨 Three outcomes, not two, because "I will not splice this" and "the regex
 * replay should handle this" are different statements and treating them as one
 * corrupted documents. Only `unrecognised` may reach the fallback.
 *
 * 🔑 The line between the two "no"s is **whether the parser LOCATED the
 * construct**, not whether the construct is an inline link. The replay is keyed
 * on href alone, so handing it a link it cannot re-derive from the source does
 * not rewrite that link — it rewrites whatever OTHER construct in the document
 * happens to share the href. A construct with a usable span is therefore never
 * fallback material, whatever its form: if this pass will not re-emit it, the
 * bytes stay as written. Only a link with no usable span — the parser could not
 * say where it is — leaves the replay as the sole thing able to find it.
 */
type SpliceVerdict =
  /** An inline link this can re-emit faithfully. */
  | { readonly outcome: 'splice'; readonly splicable: SplicableLink }
  /** A LOCATED construct it will NOT re-emit — leave the source bytes alone. */
  | { readonly outcome: 'refuse' }
  /** A link with no usable span — the regex replay is the only thing that can find it. */
  | { readonly outcome: 'unrecognised' };

/** Shared singletons, so the hot path allocates nothing for a "no". */
const UNRECOGNISED: SpliceVerdict = { outcome: 'unrecognised' };
const REFUSED: SpliceVerdict = { outcome: 'refuse' };

/**
 * Index of the `]` that closes the `[` at `start`, or undefined if unbalanced.
 *
 * Counts nesting depth and honours backslash escapes, so it handles both
 * `[a [b] c](x)` and an image inside a link — the two constructs the flat regexes
 * in this repository get wrong in opposite directions.
 *
 * 🚨 It also skips CODE SPANS, because a bracket inside one is not a bracket.
 * CommonMark binds a code span tighter than a link, so ``[the `[` matcher](x.md)``
 * is an ordinary link — but a raw depth count opened a nesting level on that `[`
 * that never closed, ran off the end of the document and returned undefined, and
 * the link was refused. It then shipped **unrewritten** and `post-build-checks`
 * reported it as `PACKAGED_BROKEN_LINK`: the author blamed for a rewriter miss,
 * over a line the parser was entirely happy with. The mirror case
 * (``[the `]` closer](x.md)``) failed the other way — the span's `]` closed the
 * construct early, so `close + 1` was not `(` — and the whole-sequence case
 * (``[see `](` here](x.md)``) was reaching the destination check as a truncating
 * splice. One cause, three symptoms.
 *
 * ⚠️ Span detection is per PARAGRAPH, matching {@link collectInlineSpans}: both
 * skip a backslash-escaped character and both close a span through
 * {@link codeSpanEnd}, bounded by {@link endOfParagraph}. Two scanners
 * disagreeing about where a code span is — measured, on an escaped backtick the
 * mask honoured and this did not — is the divergence this module exists to stop
 * repeating, so the rules live in those two functions and nowhere else.
 */
function matchingBracketEnd(content: string, start: number): number | undefined {
  let depth = 0;
  // Computed on the first backtick and refreshed only on crossing, so a link with
  // no code span never scans for its paragraph end, and one with many backticks
  // scans for it once.
  let paragraphEnd: number | undefined;
  let i = start;
  while (i < content.length) {
    const character = content.charAt(i);
    if (character === '\\') {
      // An escaped character is never structural — including an escaped backtick,
      // which does not open a code span.
      i += 2;
      continue;
    }
    if (character === '`') {
      if (paragraphEnd === undefined || i >= paragraphEnd) paragraphEnd = endOfParagraph(content, i);
      i = codeSpanEnd(content, i, paragraphEnd) ?? endOfBacktickRun(content, i);
      continue;
    }
    if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return undefined;
}

/**
 * Promote a parsed link to a {@link SplicableLink}, or decline it.
 *
 * Declining is deliberate and conservative. We decline:
 *
 * - **a link with no usable span** — `startOffset`/`endOffset` are optional, and
 *   the HTML producer really does emit a link carrying a line and no offsets.
 *   This is `UNRECOGNISED`: nothing here knows where the construct is, so the
 *   regex replay is the only thing that can find it, and dropping the link
 *   instead would silently stop rewriting it;
 * - **a construct that does not start with `[`** — an autolink or an `<a href>`,
 *   neither of which the inline-link template vocabulary describes;
 * - **a construct that is not `[...](...)`** — most importantly a reference-style
 *   USE (`[t][id]`), where splicing an inline template over the span would
 *   silently convert a reference link into an inline one. That is a change to the
 *   document's link FORM, not to its target, and no caller asked for it.
 *
 * 🚨 The last two are `REFUSED`, not `UNRECOGNISED`, and calling them
 * `UNRECOGNISED` shipped a live corruption. They HAVE a span — the parser found
 * them — they are merely forms this pass will not re-emit. `MARKDOWN_LINK_REGEX`
 * matches only `[text](href)`, so it can never re-derive an autolink, an
 * `<a href>` or a `[t][id]` from the source; putting one into `fallbackByHref`
 * therefore cannot rewrite that link at all. What it CAN do is fire on some
 * other construct that happens to share the href — and a markdown image is never
 * a `ResourceLink` (pinned by `link-grammar-divergence.test.ts`), so an image is
 * never a splice candidate, never refused, and is pure prey. Measured:
 * `[t][id]` beside `![alt](y.md)` sharing `y.md` left the use unrewritten and
 * rewrote the IMAGE. The `REFUSED` fix that closed this for the destination
 * check below was never applied to these two, so the defect stayed live.
 *
 * ⛔ The discriminator is the SPAN, not the form. Do not "improve" this by
 * enumerating node types: `nodeType` is `link` for both an inline link and an
 * autolink, so it cannot answer the question, and a form nobody has enumerated
 * yet must fail closed rather than reach an href-keyed replay.
 */
function splicableFrom(content: string, link: ResourceLink): SpliceVerdict {
  const { startOffset: start, endOffset: end } = link;
  if (start === undefined || end === undefined) return UNRECOGNISED;
  // A span that does not address this string is not a location either: `links`
  // and `content` disagree, so nothing here knows where the construct is.
  if (start >= end || end > content.length) return UNRECOGNISED;

  // ⬇️ Past this point the construct is LOCATED, so every "no" below is REFUSED.
  if (content.charAt(start) !== '[') return REFUSED;

  const close = matchingBracketEnd(content, start);
  if (close === undefined || close >= end) return REFUSED;
  if (content.charAt(close + 1) !== '(' || content.charAt(end - 1) !== ')') return REFUSED;

  // 🚨 The destination the SPAN points at must be EXACTLY the href the parser
  // reported. This one check carries three separate hazards, and each of them
  // shipped:
  //
  // 1. **A span measured against different bytes.** `links` and `content` must
  //    come from the same string, and the only production caller passed a
  //    frontmatter-STRIPPED body with full-document offsets — every span off by
  //    the frontmatter length. Most declined harmlessly, but a stale span can
  //    also land on a *different*, structurally valid link and rewrite ITS href
  //    to the first link's target.
  //
  //    ⛔ **This check MITIGATES that; it does not prevent it, and a docstring
  //    here used to say it made the corruption "unconstructible rather than
  //    merely unlikely". That was false.** The comparison is keyed on the HREF,
  //    which two links in one document routinely share, so a stale span landing
  //    on a same-href neighbour passes it and the neighbour is rewritten through
  //    the first link's metadata. Constructed in `content-transform.test.ts` ›
  //    *two links sharing an href defeat the destination comparison*: a
  //    frontmatter block tuned to the distance between two equal-length links
  //    makes their labels swap places, with every guard in this function
  //    satisfied. It cannot be closed from inside this function either — the
  //    only field that would distinguish the two is `link.text`, and mdast
  //    reduces `[**a** _b_](x)` to `a b`, so comparing it to the span's raw text
  //    would refuse correct rewrites to catch this one.
  //
  //    🔑 The guarantee is therefore the PRECONDITION this module's docstring
  //    states — `links` must come from the same bytes as `content` — and only a
  //    caller can establish it. The production caller does, and verifies it:
  //    `skill-packager.ts › bodyRelativeLinks` checks that the body it re-bases
  //    onto is a literal suffix of the content the links were parsed from, which
  //    is exactly the condition under which the re-base is exact. Read that
  //    docstring before adding a defence here.
  // 2. **A destination this template cannot re-emit.** The splice replaces
  //    `[start, end)` while `renderLink` re-emits only text and href, so
  //    anything else in the span is DESTROYED: `[a](x.md "Title")` loses its
  //    title, and `[Guide](<my guide.md>)` loses the angle brackets that made
  //    the space legal — emitting markdown that no longer parses as a link. All
  //    of those have a destination region that is not the bare href, so all of
  //    them now decline and keep their old, untouched behaviour.
  // 3. **A `close` that is not the construct's own.** Any disagreement between
  //    what `matchingBracketEnd` found and what the parser meant lands here: the
  //    region after that bracket is then not the href, so the truncating splice
  //    declines instead of deleting the bytes in between. This used to be doing
  //    real work for code spans — ``[see `](` here](x.md)`` closed early on the
  //    bracket inside the span — but that is now handled where it belongs, in
  //    `matchingBracketEnd` itself, and such a link is spliced rather than
  //    refused. What remains here is the general case: a `close` derived from
  //    bytes the parser was not describing.
  //
  // ⚠️ Equality, not `includes`: a destination that merely CONTAINS the href is
  // exactly the title/angle-bracket case, which is the one this must refuse.
  //
  // 🚨 REFUSED, not UNRECOGNISED, and the difference is destructive. A refusal
  // here means "this really is an inline link, and I will not re-emit it" —
  // the caller must then leave it verbatim. Returning the same "no" as a
  // reference-style use put it into `fallbackByHref` instead, which turned the
  // regex replay back on for its href. Measured: a titled link sharing an href
  // with an image (`[Spec](evals/d.png "Spec")` beside `![d](evals/d.png)`)
  // left the link unrewritten AND rewrote the IMAGE to `!d` — an orphaned bang
  // and a destroyed image, which is the very defect this file's probe test is
  // named after. The guard added to stop one corruption switched another back
  // on.
  //
  // ⚠️ `.trim()` because surrounding whitespace is legal CommonMark and
  // `renderLink` reproduces such a destination exactly. Escaped (`x\_y.md`) and
  // character-reference (`caf&eacute;.md`) destinations still refuse: mdast
  // decodes them, so the region does not match, and rather than re-implement
  // its decoder those keep the untouched behaviour they already had.
  if (content.slice(close + 2, end - 1).trim() !== link.href) return REFUSED;

  return { outcome: 'splice', splicable: { link, start, end, rawText: content.slice(start + 1, close) } };
}

/**
 * Every splice candidate, in source order, and the outermost survivor of any
 * overlap.
 *
 * Overlap is not expected from mdast, which does not nest link nodes, but the
 * link list is a merge of more than one producer and a nested pair would
 * otherwise be spliced twice — the second splice landing inside text the first
 * already replaced. Sorting by `(start asc, end desc)` puts the outermost first,
 * and the sweep keeps it.
 */
function splicableLinks(content: string, links: ResourceLink[]): {
  spliced: SplicableLink[];
  candidates: ReadonlySet<ResourceLink>;
  refused: ReadonlySet<ResourceLink>;
} {
  const found: SplicableLink[] = [];
  // Links this LOCATED and declined to re-emit. They are NOT fallback material:
  // replaying the regex for one rewrites whatever else in the document shares
  // its href — measured, an image next to a titled link, and an image next to a
  // reference-style use.
  const refused = new Set<ResourceLink>();
  for (const link of links) {
    if (link.nodeType === 'definition') continue; // Definitions are handled in pass 2
    const verdict = splicableFrom(content, link);
    if (verdict.outcome === 'splice') found.push(verdict.splicable);
    else if (verdict.outcome === 'refuse') refused.add(link);
  }
  found.sort((a, b) => (a.start - b.start) || (b.end - a.end));

  const spliced: SplicableLink[] = [];
  let lastEnd = -1;
  for (const candidate of found) {
    if (candidate.start < lastEnd) continue;
    spliced.push(candidate);
    lastEnd = candidate.end;
  }
  return { spliced, candidates: new Set(found.map((f) => f.link)), refused };
}

/**
 * Render one link through its first matching rule, or through `defaultTemplate`.
 * Returns undefined when nothing matches, meaning "leave the source untouched".
 *
 * `rawText` preserves any inline formatting the author wrote (backticks, bold,
 * a nested image) so a template can re-emit the link with its original styling.
 */
function renderLink(
  link: ResourceLink,
  rawText: string,
  options: ContentTransformOptions,
): string | undefined {
  const { linkRewriteRules, resourceRegistry, context, sourceFilePath, defaultTemplate } = options;

  const resource = link.resolvedId === undefined || resourceRegistry === undefined
    ? undefined
    : resourceRegistry.getResourceById(link.resolvedId);

  const template = findMatchingRule(link, resource, linkRewriteRules)?.template ?? defaultTemplate;
  if (template === undefined) return undefined;

  const [hrefWithoutFragment, anchor] = splitHrefAnchor(link.href);
  const fragment = anchor === undefined ? '' : `#${anchor}`;
  const templateContext = buildTemplateContext(
    link, hrefWithoutFragment, fragment, resource, context, sourceFilePath, rawText,
  );
  return renderHandlebarsTemplate(template, templateContext);
}

/**
 * The pre-span behaviour, applied ONLY to the stretches between spliced links and
 * ONLY on behalf of links that could not be spliced (see {@link splicableFrom}).
 *
 * `base` is the segment's offset in the whole document, because `codeRanges` is
 * measured there.
 */
function replayUnsplicable(
  segment: string,
  base: number,
  fallbackByHref: ReadonlyMap<string, ResourceLink>,
  codeRanges: ReadonlyArray<readonly [number, number]>,
  options: ContentTransformOptions,
): string {
  if (fallbackByHref.size === 0) return segment;
  return segment.replaceAll(
    MARKDOWN_LINK_REGEX,
    (fullMatch, rawText: string, href: string, offset: number) => {
      if (isInsideCode(base + offset, codeRanges)) return fullMatch;
      const link = fallbackByHref.get(href);
      if (link === undefined) return fullMatch;
      return renderLink(link, rawText, options) ?? fullMatch;
    },
  );
}

/**
 * One edit to `content`: replace `[start, end)` with `replacement`.
 *
 * Inline links and definitions both become edits, so a single walk over the
 * document applies them in source order and the definition pass never has to
 * re-find its constructs in a string pass 1 has already reshaped — the offsets
 * the parser gave are measured against `content`, and `content` is the only
 * string they are ever applied to.
 */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  /**
   * The edit deleted a whole definition line, so the blank lines around it are
   * the rewriter's own and may be collapsed — see {@link collapseBlankRunAt}.
   */
  readonly removedLine: boolean;
}

/**
 * Edits for pass 1 — inline links, span-first — plus the two sets the fallback
 * replay must exclude (see {@link rewriteLinks}).
 */
function inlineEdits(
  content: string,
  links: ResourceLink[],
  options: ContentTransformOptions,
): { edits: Edit[]; candidates: ReadonlySet<ResourceLink>; refused: ReadonlySet<ResourceLink> } {
  const { spliced, candidates, refused } = splicableLinks(content, links);
  const edits = spliced.map((s): Edit => ({
    start: s.start,
    end: s.end,
    replacement: renderLink(s.link, s.rawText, options) ?? content.slice(s.start, s.end),
    removedLine: false,
  }));
  return { edits, candidates, refused };
}

/** Index of the first `]` at or after `from` that is not backslash-escaped, before `limit`. */
function unescapedBracketEnd(text: string, from: number, limit: number): number | undefined {
  for (let i = from; i < limit; i += 1) {
    const character = text.charAt(i);
    if (character === '\\') i += 1;
    else if (character === ']') return i;
  }
  return undefined;
}

/**
 * Pass 2 — rewrite `[ref]: url` definitions, span-first, exactly as pass 1 does.
 *
 * 🚨 This used to replay `MARKDOWN_DEFINITION_REGEX` and correlate on
 * `${text}\0${href}` — and `text`, for a `definition`, is mdast's NORMALISED
 * identifier (lower-cased, whitespace-collapsed), while the regex captured the
 * label as WRITTEN. `[API]: ./api.md` built the key `api\0./api.md` and looked
 * up `API\0./api.md`, so any label with an upper-case letter or a doubled space
 * was never rewritten and never removed, at exit 0. Every fixture was a
 * lower-case single token, so the suite could not see it. Correlating two
 * grammars on a value they normalise differently cannot be made correct — the
 * argument {@link SplicableLink} makes for pass 1 — so this pass now splices at
 * the `definition` node's own span too.
 *
 * Declining is as conservative as pass 1's: the span must start with `[`, the
 * label must close on an unescaped `]:`, and the region after it must be the
 * bare href the parser reported — a title or angle brackets there would be
 * destroyed by re-emitting `[label]: path`, so those keep their bytes. The
 * whitespace around the destination is kept exactly as written.
 */
function definitionEdits(content: string, links: ResourceLink[], options: ContentTransformOptions): Edit[] {
  const edits: Edit[] = [];
  for (const link of links) {
    if (link.nodeType !== 'definition') continue;
    const edit = definitionEdit(content, link, options);
    if (edit !== undefined) edits.push(edit);
  }
  return edits;
}

/** One definition's edit, or undefined to leave its bytes alone. */
function definitionEdit(content: string, link: ResourceLink, options: ContentTransformOptions): Edit | undefined {
  const { startOffset: start, endOffset: end } = link;
  if (start === undefined || end === undefined || start >= end || end > content.length) return undefined;
  if (content.charAt(start) !== '[') return undefined;
  const labelEnd = unescapedBracketEnd(content, start + 1, end);
  if (labelEnd === undefined || content.charAt(labelEnd + 1) !== ':') return undefined;

  const region = content.slice(labelEnd + 2, end);
  const destination = region.trim();
  if (destination === '' || destination !== link.href) return undefined;

  const rewritten = renderDefinition(link, options);
  if (rewritten === undefined) return undefined;
  if (rewritten === '') return { start, end, replacement: '', removedLine: true };

  const leading = region.slice(0, region.indexOf(destination));
  const trailing = region.slice(leading.length + destination.length);
  return {
    start,
    end,
    replacement: `${content.slice(start, labelEnd + 2)}${leading}${rewritten}${trailing}`,
    removedLine: false,
  };
}

/**
 * The definition's new destination, `''` to remove the orphaned definition, or
 * undefined to leave it untouched (no rule matched and no default template).
 *
 * A rule that matches but resolves to no resource means the target does not
 * ship: the inline uses were stripped to text, so the definition is an orphan.
 */
function renderDefinition(link: ResourceLink, options: ContentTransformOptions): string | undefined {
  const { linkRewriteRules, resourceRegistry, sourceFilePath, defaultTemplate } = options;
  const resource = link.resolvedId === undefined || resourceRegistry === undefined
    ? undefined
    : resourceRegistry.getResourceById(link.resolvedId);
  const template = findMatchingRule(link, resource, linkRewriteRules)?.template ?? defaultTemplate;
  if (template === undefined) return undefined;
  if (resource === undefined || sourceFilePath === undefined) return '';

  const [, anchor] = splitHrefAnchor(link.href);
  const fragment = anchor === undefined ? '' : `#${anchor}`;
  return `${toForwardSlash(safePath.relative(path.dirname(sourceFilePath), resource.filePath))}${fragment}`;
}

/**
 * Every edit in source order, keeping the outermost survivor of any overlap.
 *
 * Overlap is not expected from mdast, which does not nest link nodes and never
 * puts a definition inside one, but the link list is a merge of more than one
 * producer and a nested pair would otherwise be spliced twice — the second
 * splice landing inside text the first already replaced. Sorting by
 * `(start asc, end desc)` puts the outermost first, and the sweep keeps it.
 */
function orderedEdits(edits: Edit[]): Edit[] {
  edits.sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const kept: Edit[] = [];
  let lastEnd = -1;
  for (const edit of edits) {
    if (edit.start < lastEnd) continue;
    kept.push(edit);
    lastEnd = edit.end;
  }
  return kept;
}

/** True for the two characters a line ending is made of. */
function isLineEndingChar(character: string): boolean {
  return character === '\n' || character === '\r';
}

/**
 * Collapse the run of line endings around `at` to at most two, in the ending the
 * run was written with — a mixed run keeps CRLF, which is the ending the removed
 * definition's own line carried.
 *
 * Only the run TOUCHING the removal is examined, so a run anywhere else in the
 * document — inside a fence, or deliberate in prose — is content and stays.
 */
function collapseBlankRunAt(text: string, at: number): string {
  let start = at;
  while (start > 0 && isLineEndingChar(text.charAt(start - 1))) start -= 1;
  let end = at;
  while (end < text.length && isLineEndingChar(text.charAt(end))) end += 1;
  const run = text.slice(start, end);
  const collapsed = run.replaceAll(BLANK_LINE_RUN_REGEX, (r) => (r.includes('\r') ? '\r\n\r\n' : '\n\n'));
  return collapsed === run ? text : `${text.slice(0, start)}${collapsed}${text.slice(end)}`;
}

/**
 * Apply both passes in one walk over `content`.
 *
 * Walks the edits in source order, replaying the legacy regex only over the gaps
 * between them and only for links that had no splice candidate. A link that WAS
 * a candidate is excluded from the fallback map even if the overlap sweep
 * dropped it, so a nested pair can never be rewritten twice or reintroduce the
 * href-correlation defect through the back door.
 */
function rewriteLinks(content: string, links: ResourceLink[], options: ContentTransformOptions): string {
  const { edits: inline, candidates, refused } = inlineEdits(content, links, options);
  const edits = orderedEdits([...inline, ...definitionEdits(content, links, options)]);

  const fallbackByHref = new Map<string, ResourceLink>();
  for (const link of links) {
    // 🚨 `refused` is excluded for a different reason than `candidates`, and
    // omitting it was destructive. A candidate is excluded so a nested pair is
    // not rewritten twice. A REFUSED link is excluded because the replay is
    // keyed on href alone and would rewrite every OTHER construct sharing that
    // href — an image beside a titled link was measured losing its `[...]` and
    // keeping an orphaned `!`, and an image beside a reference-style `[t][id]`
    // the same way. A construct this located and declined to re-emit must leave
    // the document exactly as it found it, neighbours included.
    //
    // What remains in the map is exactly the links with no usable span. Those
    // are the only ones the replay can be right about, because they are the only
    // ones for which finding the construct in the raw text is the whole job.
    //
    // 🚨 An `htmlAttribute` link is excluded even without a span, and this is
    // not the `nodeType` enumeration the ⛔ in `splicableFrom` warns against.
    // That warning is about `link` vs autolink, which SHARE a type and so cannot
    // be told apart by it. `htmlAttribute` is decisive the other way: the
    // replay's grammar is `[text](href)` and an `<a href>` can never match it,
    // so the only thing such an entry could do was fire on a DIFFERENT
    // construct sharing the href — an image beside a spanless `<a>` was
    // measured being rewritten through the anchor's metadata, the third door
    // of the corruption closed above for titled links and reference uses. And
    // the HTML producer is the one REAL source of a line-only link (an
    // `xlink:href` whose attribute span parse5 cannot locate), so this is the
    // shape that actually reached the map.
    if (link.nodeType === 'definition' || link.nodeType === 'htmlAttribute') continue;
    if (candidates.has(link) || refused.has(link)) continue;
    if (!fallbackByHref.has(link.href)) fallbackByHref.set(link.href, link);
  }

  // Ranges to leave alone: link syntax inside code is an example, not a link.
  // Only the fallback replay needs them — mdast yields no link node inside code.
  const codeRanges = codeSpanRanges(content);

  let out = '';
  let cursor = 0;
  const removals: number[] = [];
  for (const edit of edits) {
    out += replayUnsplicable(content.slice(cursor, edit.start), cursor, fallbackByHref, codeRanges, options);
    if (edit.removedLine) removals.push(out.length);
    out += edit.replacement;
    cursor = edit.end;
  }
  out += replayUnsplicable(content.slice(cursor), cursor, fallbackByHref, codeRanges, options);

  // Last removal first, so each earlier offset still names the bytes it did.
  for (const at of removals.toReversed()) out = collapseBlankRunAt(out, at);
  return out;
}

/**
 * Transform markdown content by rewriting links according to rules.
 *
 * This is a pure function that takes content, its parsed links, and transform options,
 * and returns the content with matching links rewritten according to the first matching rule.
 *
 * Two kinds of link are rewritten, in one walk over the document:
 * 1. **Inline links** `[text](href)` — matched via rules, rendered through templates
 * 2. **Definition lines** `[ref]: url` — matched via rules, rewritten in definition format
 *    or removed if orphaned (target not in registry)
 *
 * Links matching no rule are left untouched unless a `defaultTemplate` is provided.
 *
 * Both identify each construct by the SPAN the parser gave it, not by matching a
 * regex and correlating on href or label — see {@link SplicableLink} and
 * {@link definitionEdits} for why that correlation could not be made correct.
 * `links` must therefore come from the same bytes as `content`; passing links
 * parsed from a different revision of the document would splice at stale offsets.
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
  const { linkRewriteRules, defaultTemplate } = options;

  // If there are no rules, no default template, or no links, return content unchanged
  if ((linkRewriteRules.length === 0 && defaultTemplate === undefined) || links.length === 0) {
    return content;
  }

  return rewriteLinks(content, links, options);
}

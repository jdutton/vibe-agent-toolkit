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
// The `\s*` and the capture must not both be able to match a space — that
// ambiguity is what made the old `\s*(.+)` form backtrack super-linearly.
// Requiring the destination to start with `\S` makes them disjoint while
// keeping CommonMark's destination-on-the-next-line form working. The only
// input that behaves differently is a whitespace-only destination, which both
// callers `.trim()` to '' and then fail to find in the registry regardless.
const MARKDOWN_DEFINITION_REGEX = /^\[([^\]]*)\]:\s*(\S[^\n]*)$/gm;

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
 */
function matchingBracketEnd(content: string, start: number): number | undefined {
  let depth = 0;
  for (let i = start; i < content.length; i += 1) {
    const ch = content.charAt(i);
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
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
  //    to the first link's target. Comparing the destination to the href makes
  //    that unconstructible rather than merely unlikely.
  // 2. **A destination this template cannot re-emit.** The splice replaces
  //    `[start, end)` while `renderLink` re-emits only text and href, so
  //    anything else in the span is DESTROYED: `[a](x.md "Title")` loses its
  //    title, and `[Guide](<my guide.md>)` loses the angle brackets that made
  //    the space legal — emitting markdown that no longer parses as a link. All
  //    of those have a destination region that is not the bare href, so all of
  //    them now decline and keep their old, untouched behaviour.
  // 3. **A closing bracket found inside a code span.** `matchingBracketEnd`
  //    counts raw brackets and cannot see code spans, so `[see `](` here](x.md)`
  //    reports a `close` in the middle of the construct. The region that follows
  //    is not the href, so the truncating splice — which deleted prose and left
  //    an unbalanced backtick — declines instead.
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
 * Pass 1 — rewrite inline links, span-first.
 *
 * Walks the spliced links in source order, replaying the legacy regex only over
 * the gaps between them and only for links that had no splice candidate. A link
 * that WAS a candidate is excluded from the fallback map even if the overlap
 * sweep dropped it, so a nested pair can never be rewritten twice or reintroduce
 * the href-correlation defect through the back door.
 */
function rewriteInlineLinks(
  content: string,
  links: ResourceLink[],
  options: ContentTransformOptions,
): string {
  const { spliced, candidates, refused } = splicableLinks(content, links);

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
    if (link.nodeType === 'definition' || candidates.has(link) || refused.has(link)) continue;
    if (!fallbackByHref.has(link.href)) fallbackByHref.set(link.href, link);
  }

  // Ranges to leave alone: link syntax inside code is an example, not a link.
  // Only the fallback replay needs them — mdast yields no link node inside code.
  const codeRanges = codeSpanRanges(content);

  let out = '';
  let cursor = 0;
  for (const s of spliced) {
    out += replayUnsplicable(content.slice(cursor, s.start), cursor, fallbackByHref, codeRanges, options);
    out += renderLink(s.link, s.rawText, options) ?? content.slice(s.start, s.end);
    cursor = s.end;
  }
  return out + replayUnsplicable(content.slice(cursor), cursor, fallbackByHref, codeRanges, options);
}

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
 * Pass 1 identifies each link by the SPAN the parser gave it, not by matching a
 * regex and correlating on href — see {@link SplicableLink} for why that
 * correlation could not be made correct. `links` must therefore come from the same
 * bytes as `content`; passing links parsed from a different revision of the
 * document would splice at stale offsets.
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
  const { linkRewriteRules, resourceRegistry, sourceFilePath, defaultTemplate } = options;

  // If there are no rules, no default template, or no links, return content unchanged
  if ((linkRewriteRules.length === 0 && defaultTemplate === undefined) || links.length === 0) {
    return content;
  }

  // === Pass 1: Inline links [text](href) ===

  let result = rewriteInlineLinks(content, links, options);

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
    // Recomputed against `result`, NOT reused from pass 1. Pass 1 rewrites change
    // the string's length, so a range measured on `content` names the wrong bytes
    // here — which would mask a real definition or spare an example at random.
    const definitionCodeRanges = codeSpanRanges(result);
    result = result.replaceAll(
      MARKDOWN_DEFINITION_REGEX,
      (fullMatch, ref: string, href: string, offset: number) => {
        if (isInsideCode(offset, definitionCodeRanges)) return fullMatch;
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

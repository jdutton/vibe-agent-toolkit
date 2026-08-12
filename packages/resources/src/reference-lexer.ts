/**
 * Raw-source lexer for reference candidates markdown's AST cannot see.
 *
 * ## Why a raw-source scan
 *
 * `@docs/x.md`, `${CLAUDE_PLUGIN_ROOT}/scripts/x.js` and
 * `packages/utils/index.ts` are not markdown constructs. remark parses them
 * as plain text, so an mdast-based collector is structurally blind to them —
 * the same blindness `unresolved-references.ts` documents for dangling
 * reference-style links, and the same remedy: scan the source, use AST node
 * positions for context.
 *
 * ## Code context is recorded, never used to drop a token
 *
 * Anthropic documents that Claude Code's import parser **skips code spans and
 * fenced blocks**, so `inCodeSpan`/`inFence` decide whether an `@` token is
 * an import at all. That decision belongs to a lens, not here. A scanner that
 * silently drops the token cannot be second-guessed; a row carrying
 * `inFence: true` can be filtered by any query that wants to.
 *
 * ## What IS dropped, and why
 *
 * Four AST regions are excluded outright, because a candidate found in them
 * is either already recorded as a markdown-form reference or provably not a
 * reference:
 *
 * - `link` / `image` / `linkReference` / `definition` nodes — the markdown
 *   forms already produce their own reference rows, and re-lexing the
 *   destination would double-count `[a](./b.md)`.
 * - `yaml` frontmatter — which frontmatter values are references at all is
 *   decided by a collection's `frontmatterSchema` (the interpretation facet),
 *   not by a lexer. `schema-uri-walker.ts` owns that.
 * - `html` nodes — Anthropic documents that block-level HTML comments are
 *   stripped before injection, so an `@` token there never becomes an import.
 *   (Comments *inside* code blocks are preserved, and those are `code` nodes,
 *   which are not excluded.)
 *
 * Nothing else is dropped. Meaning is a lens's job.
 */

import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';

import { forEachScannableLine } from './scan-lines.js';
import type { VariableExpansionSyntax } from './schemas/projection-blobs.js';

/** Half-open character-offset range `[start, end)`. */
export type OffsetRange = [number, number];

/**
 * The three offset-range sets one AST walk yields: two that annotate a token,
 * one that suppresses it.
 */
export interface CodeContextRanges {
  /** Fenced and indented code blocks. */
  fences: OffsetRange[];
  /** Inline code spans. */
  codeSpans: OffsetRange[];
  /** Regions no lexical reference may be reported from — see module doc. */
  excluded: OffsetRange[];
}

/** A reference candidate the markdown AST does not produce. */
export interface LexicalReference {
  /** The token as authored, with trailing sentence punctuation stripped. */
  raw: string;
  /** 1-based line. */
  line: number;
  /** 1-based column of the token's first character. */
  column: number;
  syntacticForm: 'at-prefixed' | 'env-anchored' | 'bare-token';
  hasExtension: boolean;
  leadingAt: boolean;
  slashCount: number;
  variableExpansion: VariableExpansionSyntax | null;
  inCodeSpan: boolean;
  inFence: boolean;
}

/** Node kinds {@link collectCodeContextRanges} reacts to, as one filtered walk. */
const CONTEXT_NODE_TYPES = [
  'code',
  'inlineCode',
  'html',
  'yaml',
  'link',
  'image',
  'linkReference',
  'definition',
] as const;

/**
 * Walk the AST **once** for all three range sets.
 *
 * Deliberately not a call to `collectMaskedRanges` from
 * `unresolved-references.ts`: that function lumps `code`, `inlineCode`, `html`
 * and `yaml` into one undifferentiated mask, and the whole point here is that
 * the first two must stay *distinguishable from each other* and must not
 * suppress anything.
 */
export function collectCodeContextRanges(tree: Root): CodeContextRanges {
  const fences: OffsetRange[] = [];
  const codeSpans: OffsetRange[] = [];
  const excluded: OffsetRange[] = [];

  visit(tree, [...CONTEXT_NODE_TYPES], (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    // Not a `switch`: only two of the eight visited types are named here, and
    // `@typescript-eslint/switch-exhaustiveness-check` requires a switch over a
    // union to name every member even when a `default` covers the remainder.
    if (node.type === 'code') fences.push([start, end]);
    else if (node.type === 'inlineCode') codeSpans.push([start, end]);
    else excluded.push([start, end]);
  });

  return { fences, codeSpans, excluded };
}

/** Whether `[start, end)` falls inside any of `ranges`. */
function isWithin(start: number, end: number, ranges: OffsetRange[]): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start >= rangeStart && end <= rangeEnd);
}

const BRACE_EXPANSION = /\$\{[A-Za-z_]\w*\}/u;
const POWERSHELL_EXPANSION = /\$env:[A-Za-z_]\w*/u;
const BARE_EXPANSION = /\$[A-Za-z_]\w*/u;
const PERCENT_EXPANSION = /%[A-Za-z_]\w*%/u;

/**
 * Which variable-expansion syntax a token uses, if any.
 *
 * Order matters: `${A}` also matches nothing in {@link BARE_EXPANSION}
 * (the `{` stops it), but `$env:X` DOES match `BARE_EXPANSION` as `$env`, so
 * PowerShell must be tested first. Each pattern requires a plausible variable
 * name, which is what stops `costs $5` and `100%` from reading as expansions.
 */
export function detectVariableExpansion(token: string): VariableExpansionSyntax | null {
  if (BRACE_EXPANSION.test(token)) return 'brace';
  if (POWERSHELL_EXPANSION.test(token)) return 'powershell';
  if (PERCENT_EXPANSION.test(token)) return 'percent';
  if (BARE_EXPANSION.test(token)) return 'bare';
  return null;
}

/** Trailing characters that end a sentence rather than a path. */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '"', "'", '`', '>']);

/**
 * Strip sentence punctuation from a token's tail.
 *
 * `Read @README.md.` ends in two dots: one belongs to the extension, one to
 * the sentence. Stripping right-to-left while the last character is
 * punctuation removes the second and stops at `d`.
 */
export function stripTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(token.charAt(end - 1))) end--;
  return token.slice(0, end);
}

/** Opening delimiters an author wraps a token in — the mirror of {@link TRAILING_PUNCTUATION}. */
const LEADING_DELIMITERS = new Set(['`', '(', '[', '{', '"', "'", '<']);

/**
 * Strip opening delimiters from a token's head, reporting how many were removed.
 *
 * A code span is a *single* whitespace-delimited token including its backticks
 * — `` `@docs/x.md` `` — so without a leading strip the module's most
 * load-bearing column, `inCodeSpan`, could never be observed on the very
 * tokens it exists to annotate. The count is returned rather than discarded
 * because `column` and the offsets used for range containment must both point
 * at the token's first real character, not at the delimiter.
 */
export function stripLeadingDelimiters(token: string): { token: string; stripped: number } {
  let start = 0;
  while (start < token.length && LEADING_DELIMITERS.has(token.charAt(start))) start++;
  return { token: token.slice(start), stripped: start };
}

/** A dot followed by a short alphanumeric run at the very end of the token. */
const EXTENSION_SUFFIX = /\.[A-Za-z0-9]{1,8}$/u;

/**
 * Every reference candidate the markdown AST does not produce, in document
 * order.
 *
 * The line traversal and its pathological-line guard live in `scan-lines.ts`,
 * shared with `findReferenceOccurrences`. Overlong lines are skipped silently
 * there — see `MAX_SCANNED_LINE_LENGTH` — so such a line simply contributes no
 * candidates.
 *
 * @param content - Raw markdown source (the same string parsed into `tree`)
 * @param tree - The parsed AST, used only for code context and exclusions
 */
export function findLexicalReferences(content: string, tree: Root): LexicalReference[] {
  const ranges = collectCodeContextRanges(tree);
  const found: LexicalReference[] = [];

  forEachScannableLine(content, (segment, lineStart, line) => {
    scanLine(segment, lineStart, line, ranges, found);
  });

  return found;
}

/** Append every candidate on one line to `out`. */
function scanLine(
  text: string,
  lineOffset: number,
  line: number,
  ranges: CodeContextRanges,
  out: LexicalReference[],
): void {
  for (const { token, index } of whitespaceTokens(text)) {
    const { token: undelimited, stripped } = stripLeadingDelimiters(token);
    const raw = stripTrailingPunctuation(undelimited);
    if (!isCandidate(raw)) continue;
    const start = lineOffset + index + stripped;
    const end = start + raw.length;
    if (isWithin(start, end, ranges.excluded)) continue;
    out.push({
      raw,
      line,
      column: index + stripped + 1,
      syntacticForm: classify(raw),
      hasExtension: EXTENSION_SUFFIX.test(raw),
      leadingAt: raw.startsWith('@'),
      slashCount: countSlashes(raw),
      variableExpansion: detectVariableExpansion(raw),
      inCodeSpan: isWithin(start, end, ranges.codeSpans),
      inFence: isWithin(start, end, ranges.fences),
    });
  }
}

/** Whitespace-delimited runs, with the offset of each run's first character. */
function* whitespaceTokens(text: string): Generator<{ token: string; index: number }> {
  const pattern = /\S+/gu;
  let match = pattern.exec(text);
  while (match !== null) {
    yield { token: match[0], index: match.index };
    match = pattern.exec(text);
  }
}

function countSlashes(token: string): number {
  let count = 0;
  for (const char of token) if (char === '/') count++;
  return count;
}

/** A scheme-qualified URL — an external reference, not a path candidate. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

/** Explicitly relative: the author wrote a path and said so. */
const EXPLICIT_RELATIVE = /^\.{1,2}\//u;

/** A segment of digits only, on both sides of every slash — a date or a fraction. */
const ALL_NUMERIC_SEGMENTS = /^[\d./]+$/u;

/**
 * Whether a token is worth recording at all.
 *
 * `@`-prefixed and variable-bearing tokens are admitted unconditionally: both
 * carry syntax an author had to type on purpose.
 *
 * The bare-token class is **bounded**, because unbounded it fires on every
 * slash in every sentence. A bare token qualifies only when it is explicitly
 * relative (`./x`, `../x`) or when it both contains a slash and ends in a
 * file extension. This knowingly trades recall for precision — the same trade
 * `unresolved-references.ts` documents, for the same reason: a noisy signal
 * teaches its users to ignore it. Recall lost here is recoverable later by
 * the scoring lens, which has the extent a lexer does not.
 *
 * Rejected outright: scheme-qualified URLs (an external reference, not a path
 * candidate) and all-numeric segment runs (`2026/08/12`, `1/2`).
 */
function isCandidate(token: string): boolean {
  if (token.length < 2) return false;
  if (token.startsWith('@')) return true;
  if (detectVariableExpansion(token) !== null) return true;
  if (URL_SCHEME.test(token)) return false;
  if (ALL_NUMERIC_SEGMENTS.test(token)) return false;
  if (EXPLICIT_RELATIVE.test(token)) return true;
  return token.includes('/') && EXTENSION_SUFFIX.test(token);
}

/**
 * Precedence: a token carrying a variable expansion is `env-anchored`
 * whatever else it looks like, because the expansion is the fact that decides
 * whether it can resolve at all and in which extent. Otherwise a leading `@`
 * wins. Everything else is a bare token.
 */
function classify(token: string): LexicalReference['syntacticForm'] {
  if (detectVariableExpansion(token) !== null) return 'env-anchored';
  if (token.startsWith('@')) return 'at-prefixed';
  return 'bare-token';
}

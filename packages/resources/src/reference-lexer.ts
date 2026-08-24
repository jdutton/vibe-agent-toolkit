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
import type { LexicalReference } from './schemas/parse-facts.js';
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

// `LexicalReference` — the shape this module produces — is defined by
// `LexicalReferenceSchema` in `schemas/parse-facts.ts`, not here: the parse
// cache persists these rows and therefore has to validate them on read, and a
// shape with two definitions is a shape the validator can fall behind.

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

/**
 * Cut a token at its closing backtick.
 *
 * ⛔ Not the same job as {@link stripTrailingPunctuation}, and it is why that
 * function alone was not enough. Stripping walks in from the END and stops at
 * the first character that is not punctuation, so a code span followed by a
 * possessive or by emphasis keeps its closing backtick:
 *
 * ```text
 *   `@scope/pkg`'s   ->  stops at `s`   ->  raw = @scope/pkg`'s
 *   `@scope`**       ->  stops at `*`   ->  raw = @scope`**
 * ```
 *
 * 🪤 The consequence is worse than a scruffy `raw`. `end` is derived from
 * `raw.length`, so a token that runs past its closing backtick is no longer
 * CONTAINED by the code-span range, `isWithin` returns false, and `inCodeSpan`
 * is recorded as false on a reference that is plainly inside a code span. The
 * closure's guard (`closure-extent.ts` — `if (reference.inFence ||
 * reference.inCodeSpan) return false`) then never fires, and every npm scope an
 * adopter names in prose becomes an unresolved-reference warning. A guard that
 * exists and is silently defeated is worse than a missing one, because every
 * reader downstream assumes it works.
 *
 * Truncating is safe because a backtick cannot occur inside a code span's own
 * content — it would close the span — and this module already treats the
 * character as never part of a reference, listing it in BOTH
 * {@link LEADING_DELIMITERS} and {@link TRAILING_PUNCTUATION}.
 *
 * @param token - The token, already stripped of leading delimiters
 * @returns The token up to its first backtick, or unchanged when it has none
 */
function truncateAtBacktick(token: string): string {
  const close = token.indexOf('`');
  return close === -1 ? token : token.slice(0, close);
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

/**
 * A dot followed by a short alphanumeric run at the very end of the string it is tested
 * against — see {@link stripQueryOrFragment}, which is what makes that end the end of the
 * path rather than the end of the whole raw reference.
 *
 * The single definition of `hasExtension`'s predicate, shared by both `blob_references`
 * producers: this module's raw-source lexer and the AST-derived rows `projection/
 * blob-references.ts` builds from `ResourceLink.href`. `hasExtension` must mean ONE predicate
 * across the table, or a query filtering on it silently reads two different rules depending on
 * which producer emitted the row — and for a while it did: this constant and
 * {@link stripQueryOrFragment} each existed as two independent copies, one per module, with a
 * docstring in each asserting the two agreed. That assertion was true when written and then
 * went false without either file changing its OWN behaviour (below), because **a comment
 * asserting two constants agree is not a mechanism that makes them agree**. There is now one
 * copy; `blob-references.ts` imports both from here — the existing import direction, since it
 * already imports {@link detectVariableExpansion} from this module — so the invariant is
 * enforced by the module system instead of by a comment.
 *
 * ⛔ B3: `lexicalFeatures` (in `projection/blob-references.ts`) used to run this regex against
 * the WHOLE raw href. For `./guide.md?v=2` the string's own end is `2`, not `.md`, so the regex
 * never matched and `hasExtension` read `false` for a link that plainly has a `.md` extension —
 * silently, since nothing separated "no extension" from "extension pushed off the end by
 * trailing punctuation nobody stripped." Same failure for `./guide.md#section`. Pinned by
 * Task A as `it.fails` in `html-link-parser.test.ts` and fixed by stripping the query/fragment
 * first (below) before testing.
 *
 * ⛔ Task C found the OTHER producer — this module's own lexer tokens, via {@link emitToken} —
 * had the identical bug independently, and for the same reason: `emitToken` tested `raw`
 * directly instead of a stripped form. `@docs/guide.md?v=2`, `./guide.md#section` and
 * `${CLAUDE_PLUGIN_ROOT}/guide.md?v=2` (the three token classes {@link isCandidate} admits
 * UNCONDITIONALLY, which do not have to pass this regex to become a row at all) read
 * `hasExtension: false` from the lexer while the equivalent markdown link read `true` from the
 * AST side for the identical path. Fixed the same way, at the column site in {@link emitToken}.
 */
export const EXTENSION_SUFFIX = /\.[A-Za-z0-9]{1,8}$/u;

/**
 * Everything before the first `?` or `#` — the part of a reference
 * {@link EXTENSION_SUFFIX} means to test.
 *
 * Splitting on the FIRST of either delimiter (not just `?`, not just `#`) matters for the order
 * they can appear in: `?` before `#` is the common case (`?v=2#section`), but nothing in URL
 * syntax forbids the reverse, and a split anchored to only one delimiter would leave the
 * other's text attached to the "path" half — silently miscounting the extension in that href,
 * or leaving a stray trailing character after it in others.
 *
 * A fragment-only reference (`#section`) or a bare `?`/`#` correctly reduces to the empty
 * string here, which {@link EXTENSION_SUFFIX} — anchored, so it cannot match nothing — reports
 * as no extension, exactly as it should: neither has one.
 *
 * `[0] ?? token` is the same `noUncheckedIndexedAccess` guard `link-parser.ts ›
 * classifyLink` uses for the identical split: `String#split` on a defined regex always returns
 * at least one element, so the fallback is unreachable in practice and kept only because the
 * type system cannot see that.
 *
 * Two call sites test this function's result against {@link EXTENSION_SUFFIX} to fill the
 * `hasExtension` column: {@link emitToken} here, for lexer tokens, and `lexicalFeatures` in
 * `projection/blob-references.ts`, for AST hrefs. It does NOT touch the SEPARATE
 * candidate-admission regex at {@link isCandidate} — see that function's docstring for why that
 * gate is deliberately left testing the unstripped token.
 *
 * @param token - The reference exactly as authored — a lexer token (leading delimiters and
 *   trailing sentence punctuation already stripped) or an AST `href`
 * @returns `token` with any trailing `?query` or `#fragment` removed
 */
export function stripQueryOrFragment(token: string): string {
  return token.split(/[#?]/u)[0] ?? token;
}

/**
 * Every reference candidate the markdown AST does not produce, in document
 * order.
 *
 * The line traversal and its pathological-line guard live in `scan-lines.ts`,
 * shared with `findReferenceOccurrences`. Overlong lines are skipped silently
 * there — see `MAX_SCANNED_LINE_LENGTH` — so such a line simply contributes no
 * candidates.
 *
 * Takes the ranges rather than the tree so the AST is walked **once** per
 * parse: `parseMarkdownContent` needs the same {@link CodeContextRanges} for
 * `measureContent`, and a function that took the tree would have to walk it
 * again to get them.
 *
 * @param content - Raw markdown source (the same string the ranges came from)
 * @param ranges - Code context and exclusions, from {@link collectCodeContextRanges}
 * @returns Every candidate, in document order
 */
export function findLexicalReferences(content: string, ranges: CodeContextRanges): LexicalReference[] {
  const found: LexicalReference[] = [];

  forEachScannableLine(content, (segment, lineStart, line) => {
    scanLine(segment, lineStart, line, ranges, found);
  });

  return found;
}

/**
 * Exactly the code points JS `\s` matches, so the hand-rolled tokenizer splits
 * where `/\S+/u` splits. Any divergence here silently changes token boundaries.
 *
 * Guarded by a whole-corpus digest rather than by fixtures: 26,368 files and
 * 384,031 references hash identically against the `/\S+/gu` implementation this
 * replaced. Re-run that comparison before touching this set.
 */
function isSpaceCode(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/**
 * Append every candidate on one line to `out`, tokenizing and pre-filtering in
 * ONE allocation-free pass.
 *
 * ## Why this is hand-rolled rather than `/\S+/gu`
 *
 * This runs on every line of every file every command parses, and it is the
 * single largest component of that parse. Measured on an 8,473-file adopter
 * tree, cold: **+4.1% of total `vat resources validate`, 8/8 rounds, p=0.008**,
 * output byte-identical.
 *
 * The generator it replaces yielded a fresh `{token, index}` object AND a
 * sliced string for every whitespace-delimited run — then paid two strip passes
 * and up to four regexes before {@link isCandidate} discarded almost all of
 * them. Ordinary prose is the overwhelming majority of tokens and none of it can
 * ever qualify, so nearly all of that allocation was pure waste.
 *
 * Every branch of `isCandidate` that can return `true` requires one of
 * `/ $ % @`, so a run carrying none of them cannot qualify and never needs to
 * become a string at all. Detecting that inline, during the scan that already
 * has to visit each character to find the run's end, makes the rejection free.
 *
 * Testing the **unstripped** run is sound because stripping only ever REMOVES
 * leading delimiters and trailing punctuation — it can never introduce one of
 * these characters — so this can fail to skip, but never skip something that
 * would have qualified.
 *
 * ⚠️ A pre-filter alone does NOT reproduce this: rejecting after the generator
 * has already allocated measured +2.1%, p=0.388 — indistinguishable from noise.
 * The allocation is the cost, not the predicate.
 */
function scanLine(
  text: string,
  lineOffset: number,
  line: number,
  ranges: CodeContextRanges,
  out: LexicalReference[],
): void {
  const length = text.length;
  let index = 0;
  while (index < length) {
    while (index < length && isSpaceCode(text.codePointAt(index) ?? Number.NaN)) index++;
    if (index >= length) break;
    const runStart = index;
    let sigil = false;
    while (index < length && !isSpaceCode(text.codePointAt(index) ?? Number.NaN)) {
      const code = text.codePointAt(index) ?? Number.NaN;
      // '/' 47, '$' 36, '%' 37, '@' 64
      if (code === 47 || code === 36 || code === 37 || code === 64) sigil = true;
      index++;
    }
    if (!sigil) continue;
    emitToken(text.slice(runStart, index), runStart, lineOffset, line, ranges, out);
  }
}

/** The per-token tail shared by both tokenizers. */
function emitToken(
  token: string,
  index: number,
  lineOffset: number,
  line: number,
  ranges: CodeContextRanges,
  out: LexicalReference[],
): void {
  const { token: undelimited, stripped } = stripLeadingDelimiters(token);
  const raw = stripTrailingPunctuation(truncateAtBacktick(undelimited));
  if (!isCandidate(raw)) return;
  const start = lineOffset + index + stripped;
  const end = start + raw.length;
  if (isWithin(start, end, ranges.excluded)) return;
  out.push({
    raw,
    line,
    column: index + stripped + 1,
    // The span `raw` occupies, which this function already computed for the
    // code-context containment tests above. It is the token AFTER leading
    // delimiters and trailing punctuation are stripped, so replacing
    // `[startOffset, endOffset)` replaces exactly the reference and nothing
    // around it.
    startOffset: start,
    endOffset: end,
    syntacticForm: classify(raw),
    // Tested against the query/fragment-stripped form, not `raw` itself — see
    // {@link stripQueryOrFragment}. The candidate GATE at `isCandidate` still tests `token`
    // (unstripped) — a deliberate, narrower fix; see that function's docstring.
    hasExtension: EXTENSION_SUFFIX.test(stripQueryOrFragment(raw)),
    leadingAt: raw.startsWith('@'),
    slashCount: countSlashes(raw),
    variableExpansion: detectVariableExpansion(raw),
    inCodeSpan: isWithin(start, end, ranges.codeSpans),
    inFence: isWithin(start, end, ranges.fences),
  });
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
 *
 * ⚠️ Task C, deliberately NOT touched here: `EXTENSION_SUFFIX` below is the SAME regex
 * {@link emitToken} tests (via {@link stripQueryOrFragment}) to fill the `hasExtension`
 * COLUMN, but here it decides whether a bare token becomes a ROW at all — a much larger
 * blast radius, since it can add rows to `blob_references` for tokens that never produced
 * one before, flowing into closures and `vat inventory`. Stripping a query/fragment here
 * too (`docs/guide.md?v=2`, currently rejected because ITS OWN end is `2`, not `.md`) would
 * change the candidate population, not just a column value on an already-admitted row.
 * Left as `token` (unstripped) on purpose: fixing the column is sufficient to make
 * `hasExtension` mean one thing across the table (the invariant this task exists to
 * restore), because a bare token can only reach {@link emitToken} through this exact
 * branch, so if a query/fragment tail keeps it OUT, `hasExtension` is never computed for
 * it in the first place — there is no row for the value to disagree on. A wider fix here
 * would need to be measured against this repository's own corpus first (see Task C's
 * report), not assumed safe by analogy with the column fix.
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

/**
 * Detection of **dangling reference-style links** — `[text][label]` (full) or
 * `[label][]` (collapsed) occurrences whose label has no matching
 * `[label]: url` definition anywhere in the document.
 *
 * ## Why this is a raw-source scan and not an AST visit
 *
 * CommonMark resolves link references at PARSE TIME. When no definition
 * matches, micromark never emits a `linkReference` node for the construct at
 * all — it degrades to literal bracketed text. There is therefore no AST node
 * to visit for the dangling case, which is exactly why an mdast-based checker
 * (everything else in this package) is structurally blind to it while the
 * reader sees the raw `[text][label]` in the rendered document.
 *
 * ## This detector is irreducibly heuristic, and optimizes for PRECISION
 *
 * `[, options][, callback]` (an optional-argument API signature) and `[3][4]`
 * (numeric prose citations) are *syntactically* full reference links — they
 * render literally only because no definition exists, which is the same
 * condition a genuine typo produces. Authorial intent is not decidable from
 * the grammar, so no amount of CommonMark rigor separates them.
 *
 * The response is a set of small, individually-testable plausibility
 * predicates that reject occurrences whose label (or link text) does not look
 * like something a human would ever write a `[label]: url` definition for.
 * This deliberately **trades recall for precision**: a warning that fires on
 * prose is worse than a missed dangling link, because the first thing a noisy
 * validation code teaches its users is to ignore it.
 *
 * ### Known limitations (accepted, by design)
 *
 * - **Purely numeric labels are never reported.** This costs the genuine
 *   `[text][1]`-with-no-`[1]:`-definition case, but numeric-citation prose
 *   (`the host application[3][4][8].`) is far more common in real documents.
 * - **Single-character labels are never reported** (`matrix[i][j]`).
 * - **Labels starting/ending in punctuation are never reported**, except for
 *   the leading `#`/`_`/`-` that real labels do use.
 * - **Link text starting with punctuation** (other than `!`, which begins an
 *   image reference) is never reported — the other side of the API-signature
 *   pattern.
 * - **Shortcut references (`[label]` alone) are an explicit non-goal.**
 *   Bracketed prose ("see note [1]", "the [draft] version") is ubiquitous;
 *   treating every bare bracket pair as a dangling reference would be a
 *   false-positive firehose.
 * - **Single-line only.** A reference whose text or label spans a line break
 *   is not detected.
 *
 * ### Corpus evidence for the shipped severity
 *
 * Measured over a 1,822-document real-world markdown corpus (npm package
 * READMEs plus this repo's own tracked markdown): **30 hits before these
 * heuristics — 5 genuine, 25 false — and 5 hits after, all 5 genuine, zero
 * false positives.** That clean sweep is why `LINK_UNRESOLVED_REFERENCE`
 * ships at its default `warning` severity rather than advisory `info`. If a
 * wider corpus later shows false positives, drop the default to `info` before
 * loosening the heuristics.
 */

import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';

import { forEachScannableLine } from './scan-lines.js';
import type { UnresolvedReference } from './types.js';

/** ASCII punctuation, as CommonMark defines it. */
const ASCII_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u;

/** Punctuation that real reference labels genuinely start or end with. */
const LABEL_EDGE_PUNCTUATION_ALLOWLIST = new Set(['#', '_', '-']);

/**
 * Punctuation a genuine link text may start with: `!` begins an image
 * reference (`![alt][label]`), and `*`/`_`/`` ` ``/`"` begin emphasis, strong,
 * code, or a quotation inside otherwise ordinary link text
 * (`[**Bold link**][ref]`).
 */
const TEXT_LEADING_PUNCTUATION_ALLOWLIST = new Set(['!', '*', '_', '`', '"']);

/** Minimum label length worth reporting (kills `matrix[i][j]`). */
const MIN_PLAUSIBLE_LABEL_LENGTH = 2;

/**
 * Normalize a reference label the way CommonMark matches `[label]` against
 * `[label]: url` definitions: trim, collapse internal whitespace runs to a
 * single space, and case-fold. This is a practical (ASCII-focused)
 * approximation of CommonMark's Unicode case-fold — sufficient for matching
 * against mdast's own normalized `Definition.identifier` (which is already
 * whitespace-collapsed and trimmed by remark/micromark).
 *
 * @param label - Raw label text as it appears in the source
 * @returns Normalized label for definition-set membership comparison
 */
export function normalizeReferenceLabel(label: string): string {
  return label.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
}

/**
 * Remove CommonMark backslash escapes from a label.
 *
 * @param label - Raw label text as it appears in the source
 * @returns The label with `\<punctuation>` reduced to `<punctuation>`
 */
export function unescapeReferenceLabel(label: string): string {
  return label.replaceAll(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, '$1');
}

/**
 * Every normalized spelling a label may be stored/written under, so an
 * escaped label matches its own definition. mdast keeps backslash escapes in
 * `Definition.identifier` (`[foo\]bar]: url` → identifier `foo\]bar`) and
 * unescapes them only in `label`, so matching on one form alone reports
 * `[a][foo\]bar]` as dangling even though it resolves. Indexing and querying
 * both forms cannot produce a false positive — over-matching only ever
 * suppresses a finding, which is the direction this detector errs in.
 *
 * @param label - A raw source label or an mdast definition identifier
 * @returns Normalized escaped and unescaped spellings (deduplicated)
 */
export function referenceLabelKeys(label: string): string[] {
  const escaped = normalizeReferenceLabel(label);
  const unescaped = normalizeReferenceLabel(unescapeReferenceLabel(label));
  return escaped === unescaped ? [escaped] : [escaped, unescaped];
}

/**
 * A label with no alphanumeric character at all (`[--][==]`, `[+][+]`) is
 * never a label a human wrote a definition for.
 */
export function labelHasAlphanumeric(label: string): boolean {
  return /[\p{L}\p{N}]/u.test(label);
}

/**
 * A label that begins or ends with punctuation is prose or code, not a label:
 * this is what rejects the optional-argument API signature
 * `needle.get(url[, options][, callback])`. `#`, `_` and `-` are allowed
 * because real labels use them (`[Options][#fetch-options]`).
 */
export function labelHasPunctuationEdges(label: string): boolean {
  const trimmed = label.trim();
  const first = trimmed.at(0) ?? '';
  const last = trimmed.at(-1) ?? '';
  return isDisallowedEdge(first) || isDisallowedEdge(last);
}

function isDisallowedEdge(char: string): boolean {
  return ASCII_PUNCTUATION.test(char) && !LABEL_EDGE_PUNCTUATION_ALLOWLIST.has(char);
}

/**
 * A purely numeric label is a prose citation (`the host application[3][4][8].`),
 * not a reference label — see "Known limitations" in the module doc comment for
 * the recall this knowingly costs.
 */
export function labelIsPurelyNumeric(label: string): boolean {
  return /^\d+$/u.test(label.trim());
}

/**
 * A one-character label is an array subscript (`matrix[i][j]`), not a label.
 */
export function labelIsTooShort(label: string): boolean {
  return label.trim().length < MIN_PLAUSIBLE_LABEL_LENGTH;
}

/**
 * Whether a label looks like something a human would define. Composition of
 * the individual predicates above so each stays separately testable.
 */
export function isPlausibleReferenceLabel(label: string): boolean {
  return (
    labelHasAlphanumeric(label) &&
    !labelHasPunctuationEdges(label) &&
    !labelIsPurelyNumeric(label) &&
    !labelIsTooShort(label)
  );
}

/**
 * Plausibility applied to the link TEXT rather than the label — the other side
 * of the API-signature pattern (`[, options][, callback]`, whose text `,
 * options` starts with a comma). Leading `!` is allowed because `![alt][label]`
 * is a legitimate image reference; emphasis/code markers are allowed because
 * `[**Bold**][ref]` is legitimate link text.
 *
 * Only meaningful for the full form: in the collapsed form (`[label][]`) the
 * text IS the label, and {@link isPlausibleReferenceLabel} already judged it.
 */
export function isPlausibleLinkText(text: string): boolean {
  const first = text.trim().at(0) ?? '';
  if (first === '') return true;
  return !ASCII_PUNCTUATION.test(first) || TEXT_LEADING_PUNCTUATION_ALLOWLIST.has(first);
}

/** Half-open character-offset range `[start, end)`. */
type OffsetRange = [number, number];

/**
 * Structural shape of any mdast node carrying offsets (all of them do), so one
 * visitor callback can serve every masked node type.
 */
interface OffsetPositioned {
  position?:
    | { start: { offset?: number | undefined }; end: { offset?: number | undefined } }
    | undefined;
}

/**
 * Character-offset range of the destination clause of a `link`, `image`, or
 * `definition` node: `(url "title")` for an inline link/image, `: url
 * "title"` for a definition, or the WHOLE node for an autolink (`<url>` — the
 * visible text IS the url, so there is no separate label/text to keep
 * unmasked).
 *
 * Finds where the label/text bracket closes using the same
 * {@link findMatchingBracket} the raw scanner itself uses (honoring nesting
 * and escapes), then masks everything after it through the node's end. This
 * is what keeps the mask *destination-only* rather than whole-node: the
 * label/text before the close is left unmasked, so a genuine nested dangling
 * reference inside link/image text (`[![alt][inner-nope]](url)`) is still
 * found instead of being silently swallowed by the mask.
 *
 * @returns `undefined` when the node has no offset position to work from
 */
function destinationMaskRange(node: OffsetPositioned, content: string): OffsetRange | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return undefined;
  const slice = content.slice(start, end);
  const bracketStart = slice.startsWith('!') ? 1 : 0;
  if (slice[bracketStart] !== '[') return [start, end]; // autolink: no separate label/text
  const bracketClose = findMatchingBracket(slice, bracketStart);
  return bracketClose === -1 ? [start, end] : [start + bracketClose + 1, end];
}

/**
 * Node kinds {@link collectMaskFacts} reacts to.
 *
 * Passed to `visit` as its test so the walk is still ONE traversal while the
 * visitor's parameter narrows to exactly these kinds — which is what lets the
 * switch inside be exhaustive, so adding a kind here forces a case there.
 */
const MASK_NODE_TYPES = [
  'code',
  'inlineCode',
  'html',
  'yaml',
  'link',
  'image',
  'definition',
] as const;

/**
 * The two things {@link findUnresolvedReferences} needs from the AST, gathered
 * in a single walk.
 */
interface MaskFacts {
  /** Ranges the raw scanner must ignore — see {@link collectMaskedRanges}. */
  ranges: OffsetRange[];
  /** Every normalized spelling of every `[label]: url` identifier. */
  definedLabels: Set<string>;
}

/**
 * Walk the AST **once** for both the masked ranges and the defined labels.
 *
 * Replaces eight separate `visit()` passes (four whole-node mask kinds, three
 * destination-clause kinds, and the definition-identifier pass that used to
 * live in {@link findUnresolvedReferences}) with one traversal dispatching on
 * `node.type`. Each pass was a full tree walk over the same tree.
 *
 * Range ORDER changes from grouped-by-node-kind to document order, which is
 * unobservable: the only consumer is {@link isRangeFullyMasked}, whose
 * `.some()` is order-independent. Range CONTENT is unchanged.
 */
function collectMaskFacts(tree: Root, content: string): MaskFacts {
  const ranges: OffsetRange[] = [];
  const definedLabels = new Set<string>();

  const pushRange = (node: OffsetPositioned): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      ranges.push([start, end]);
    }
  };
  const pushDestinationRange = (node: OffsetPositioned): void => {
    const range = destinationMaskRange(node, content);
    if (range !== undefined) ranges.push(range);
  };

  visit(tree, [...MASK_NODE_TYPES], (node) => {
    switch (node.type) {
      case 'code':
      case 'inlineCode':
      case 'html':
      case 'yaml': {
        pushRange(node);
        break;
      }
      case 'link':
      case 'image': {
        pushDestinationRange(node);
        break;
      }
      case 'definition': {
        pushDestinationRange(node);
        for (const key of referenceLabelKeys(node.identifier)) definedLabels.add(key);
        break;
      }
    }
  });

  return { ranges, definedLabels };
}

/**
 * Character-offset ranges covered by regions whose bracket content must never
 * be interpreted as markdown: fenced/indented code blocks, inline code spans,
 * raw HTML (block and inline — `<!-- [a][nope] -->` is commented-out
 * scaffolding no reader sees, and inside an HTML block adding a definition
 * would not make the reference resolve anyway), YAML frontmatter, and the
 * destination clause (url/title) of `link`, `image`, and `definition` nodes —
 * qs/Rails-style bracket query params (`?filter[status][eq]=1`) and a title
 * containing a stray `[a][b]` are ubiquitous and not dangling references. See
 * {@link destinationMaskRange} for why only the destination, not the whole
 * node, is masked.
 *
 * Reuses the AST's own node positions rather than running a second tokenizer.
 *
 * Ranges come back in document order, and are consumed as an unordered set.
 */
export function collectMaskedRanges(tree: Root, content: string): OffsetRange[] {
  return collectMaskFacts(tree, content).ranges;
}

/**
 * Whether the half-open range `[start, end)` is entirely contained within
 * some masked range — containment, not mere overlap. A masked destination
 * range can sit INSIDE a much larger genuine occurrence (the outer reference
 * in `[![badge](i.png)][ci-nope]` fully contains the image's small `(i.png)`
 * destination mask); masking on overlap alone would incorrectly swallow that
 * outer occurrence. For code/HTML/YAML spans this is equivalent to the old
 * overlap check, since an occurrence found inside one of those was always
 * either fully inside or fully outside, never straddling the boundary.
 */
export function isRangeFullyMasked(start: number, end: number, ranges: OffsetRange[]): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start >= rangeStart && end <= rangeEnd);
}

/**
 * One `[text][label]` (or collapsed `[label][]`) occurrence found by
 * {@link findReferenceOccurrences}.
 */
export interface ReferenceOccurrence {
  /** Character offset of the opening `[`. */
  start: number;
  /** Character offset one past the final `]`. */
  end: number;
  /** 1-based line number of the occurrence. */
  line: number;
  /** Raw content of the first bracket pair. */
  text: string;
  /** Raw content of the second bracket pair (empty for the collapsed form). */
  label: string;
}

/**
 * Index of the `]` that closes the `[` at `openIndex`, honoring **nesting** and
 * backslash escapes. Nesting is what makes `[![Build][]][1]` parse as one
 * outer reference (text `![Build][]`, label `1`) instead of the inner pair
 * plus a garbage `"![Build"` label.
 *
 * Written as a character scanner rather than a regex: the same match shape a
 * regex would express, without the backtracking-risk profile of nested
 * `[^\]]*` classes over arbitrary-length input (sonarjs/slow-regex).
 *
 * @returns The index of the matching `]`, or -1 if the segment ends first
 */
export function findMatchingBracket(segment: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < segment.length; i++) {
    const char = segment[i];
    if (char === '\\') {
      i++; // Skip the escaped character.
      continue;
    }
    if (char === '[') {
      depth++;
    } else if (char === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Maximum nesting depth {@link scanSegment} will recurse into matched link
 * text.
 *
 * Real markdown nests reference-style links at most a couple of levels deep
 * (an image inside a link, at most — see the nested-reference tests).
 * Measured cost of UNBOUNDED recursion on a pathological single line built as
 * `s = '[' + s + '][b]'` repeated N times: 1k deep ~38ms, 5k ~680ms,
 * 10k ~3.3s, 15k ~16.3s — super-quadratic, because each recursion level
 * rescans the shrinking remainder of the line with its own
 * {@link findMatchingBracket} pass — and 25k throws `RangeError: Maximum
 * call stack size exceeded` after ~73s. Capping depth bounds both the call
 * stack and the total rescanned character count to O(depth × line length),
 * independent of how deep the input actually nests.
 */
const MAX_REFERENCE_NESTING_DEPTH = 20;


/**
 * Collect reference occurrences from a single-line segment, recursing into a
 * matched occurrence's link text so nested forms (`[![badge][ci-img]][ci]`)
 * report both labels.
 *
 * Recursion stops silently at {@link MAX_REFERENCE_NESTING_DEPTH}: deeper
 * nesting than that is never real markdown, and continuing would risk the
 * stack-overflow / super-quadratic blowup documented on that constant.
 * Stopping early only under-reports pathologically deep input — it never
 * throws and never mis-reports the levels within the cap.
 *
 * @param segment - Text of one line (or the text of an enclosing occurrence)
 * @param baseOffset - Absolute character offset `segment[0]` sits at
 * @param line - 1-based line number the segment belongs to
 * @param out - Accumulator, appended to in source order
 * @param depth - Current nesting depth (0 at the top-level line scan)
 */
function scanSegment(
  segment: string,
  baseOffset: number,
  line: number,
  out: ReferenceOccurrence[],
  depth = 0,
): void {
  let i = 0;
  while (i < segment.length) {
    // A `\[` is a literal bracket, not a reference opener: CommonMark makes
    // `\[a][nope]` a *shortcut* reference, which is a declared non-goal.
    const isOpener = segment[i] === '[' && !isEscaped(segment, i);
    const firstClose = isOpener ? findMatchingBracket(segment, i) : -1;
    const secondClose =
      firstClose !== -1 && segment[firstClose + 1] === '['
        ? findMatchingBracket(segment, firstClose + 1)
        : -1;
    if (secondClose === -1) {
      i++;
      continue;
    }
    const text = segment.slice(i + 1, firstClose);
    out.push({
      start: baseOffset + i,
      end: baseOffset + secondClose + 1,
      line,
      text,
      label: segment.slice(firstClose + 2, secondClose),
    });
    if (depth < MAX_REFERENCE_NESTING_DEPTH) {
      scanSegment(text, baseOffset + i + 1, line, out, depth + 1);
    }
    i = secondClose + 1;
  }
}

/** Whether the character at `index` is preceded by an odd run of backslashes. */
function isEscaped(segment: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && segment[i] === '\\'; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

/**
 * Scan raw source for two-adjacent-bracket-pair occurrences: the full
 * (`[text][label]`) and collapsed (`[label][]`) reference-style link forms.
 *
 * Scans line by line, which is both correct (a reference's brackets never
 * cross a newline here — see the single-line limitation in the module doc) and
 * cheap: the line number comes free from the loop, so no offset→line index or
 * binary search is needed.
 *
 * The traversal and its pathological-line guard live in `scan-lines.ts`, shared
 * with the raw-source reference lexer. Overlong lines are skipped silently
 * there — see `MAX_SCANNED_LINE_LENGTH` for why. This module's other guard,
 * {@link MAX_REFERENCE_NESTING_DEPTH}, is independent of it.
 */
export function findReferenceOccurrences(content: string): ReferenceOccurrence[] {
  const occurrences: ReferenceOccurrence[] = [];
  forEachScannableLine(content, (segment, lineStart, line) => {
    scanSegment(segment, lineStart, line, occurrences);
  });
  return occurrences;
}

/**
 * Detect dangling reference-style links in a parsed markdown document.
 *
 * @param content - Raw markdown source (the same string parsed into `tree`)
 * @param tree - The parsed AST, used only to mask code/HTML/frontmatter spans
 *   and to collect already-normalized definition identifiers
 * @returns One finding per plausible dangling full/collapsed reference
 */
export function findUnresolvedReferences(content: string, tree: Root): UnresolvedReference[] {
  const { ranges: maskedRanges, definedLabels } = collectMaskFacts(tree, content);
  const findings: UnresolvedReference[] = [];

  for (const occurrence of findReferenceOccurrences(content)) {
    const label = resolveOccurrenceLabel(occurrence);
    if (label === undefined) continue;
    if (isRangeFullyMasked(occurrence.start, occurrence.end, maskedRanges)) continue;
    if (referenceLabelKeys(label).some((key) => definedLabels.has(key))) continue;
    findings.push({ label, line: occurrence.line });
  }

  return findings;
}

/**
 * The label an occurrence refers to, or `undefined` when the occurrence fails
 * a plausibility predicate and must not be reported.
 *
 * Collapsed form (`[label][]`): the second bracket pair is empty, so the first
 * pair's content IS the label (CommonMark rule) — and the link-text predicate
 * does not apply, because the text and the label are the same string.
 */
function resolveOccurrenceLabel(occurrence: ReferenceOccurrence): string | undefined {
  const isCollapsed = occurrence.label.trim() === '';
  const rawLabel = isCollapsed ? occurrence.text : occurrence.label;
  if (!isPlausibleReferenceLabel(rawLabel)) return undefined;
  if (!isCollapsed && !isPlausibleLinkText(occurrence.text)) return undefined;
  return rawLabel.trim();
}

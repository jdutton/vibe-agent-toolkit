/**
 * Blob-keyed reference rows — every reference *candidate* a blob contains,
 * from the producers that can find one.
 *
 * `links` comes from a parser, `lexicalReferences` from the raw-source lexer.
 * For a **markdown** blob the two see disjoint populations by construction —
 * the lexer's excluded ranges cover exactly the AST node kinds that already
 * emit a link row — so there the union is a partition, not a merge with
 * overlap.
 *
 * ## Observed: for an HTML blob there is only one producer
 *
 * ⛔ This header used to say "both of the two producers" and call the union a
 * partition outright. Both sentences reasoned about markdown alone. `links` has
 * more than one filler — `link-parser.ts` (mdast) and `html-link-parser.ts`
 * (parse5) at least — and `parseHtmlContent` never populates
 * `lexicalReferences` at all, so for an HTML blob the interleaving below
 * degenerates to the AST side alone and the ordinal space it defends is never
 * exercised. Recorded as an OBSERVATION: nothing in the code or in
 * resource-projection.md says whether the lexer being markdown-only is a
 * modelling decision (its `@`-prefixed and `${VAR}` forms are CLAUDE.md/markdown
 * constructs) or simply unbuilt, and this comment does not claim to know.
 *
 * The consequence is a second, still-open under-report, distinct from the one
 * fixed below: an `@`-prefixed or bare path token sitting in HTML *text* — not
 * in an `href` — produces no row, because the only producer that would find it
 * never runs on that blob.
 *
 * ## One ordinal space, ordered by position
 *
 * `BlobReferenceRowSchema.ordinal` is documented as "0-based position among
 * this blob's references". Two independent ordinal spaces (AST first, lexer
 * appended) would satisfy the letter of that and make `edges.refOrdinal`
 * ambiguous the moment edges land: an ordinal would identify a row only in
 * company with the producer that emitted it, which is not a column. So the two
 * sequences are interleaved into one order keyed on `(line, column)`.
 *
 * An AST-derived row has **no** column — `ResourceLink` carries none, and the
 * schema makes `column` nullable for exactly this reason — and a null column
 * sorts before a real one on the same line. Within one producer at one
 * position the original order is preserved, so the AST's kind-order contract
 * (all `link`s, then all `linkReference`s, then all `definition`s) still
 * decides ties among rows that share a line.
 *
 * ⛔ That "original order" claim used to be one sentence covering both
 * producers. It is right for markdown and wrong for HTML. `links` order is
 * DOM/walk order for HTML (`html-link-parser.ts › walkElements`, a depth-first
 * traversal of the PARSED tree), and parse5's tree construction can MOVE a
 * node — HTML's foster-parenting rule re-parents an element that is not
 * permitted directly inside a `<table>` (a bare `<a>`, `<div>`, text) to just
 * BEFORE the table, even though it was written INSIDE it in the source. Two
 * such links can land on the same `line` (so `line` does not separate them)
 * while DOM order disagrees with source order — measured across four
 * misnesting shapes in `projection-blob-references.test.ts`'s `B1` suite,
 * two of which invert. Tie-breaking those by their index in `links` would
 * make `ordinal` — documented as "0-based position among this blob's
 * references" — silently mean "DOM order" for HTML and "source order" for
 * markdown, with nothing to tell a reader which. Fixed in {@link astCandidates}:
 * an `htmlAttribute` link's tie-break is its own `startOffset`, the one
 * authority that always agrees with the span the row itself carries. A
 * markdown link's tie-break stays its bucket index, unchanged — the two
 * producers never share a blob, so this is not a choice between the two
 * contracts, it is picking the correct one PER PRODUCER.
 *
 * ## What is deliberately NOT carried
 *
 * `ResourceLink.resolvedId` is the one field production code mutates **after**
 * the parse — `skill-packager` assigns it while bundling. A blob-keyed row is
 * content-addressed, so carrying `resolvedId` would make a blob fact depend on
 * which skill happened to be packaged first. The blob layer stores shape;
 * meaning belongs to a lens (resource-projection.md §5).
 */

import type { ParseResult } from '../link-parser.js';
import { detectVariableExpansion, EXTENSION_SUFFIX, stripQueryOrFragment } from '../reference-lexer.js';
import { LexicalSyntacticFormSchema, type LexicalReference } from '../schemas/parse-facts.js';
import {
  ReferenceSyntacticFormSchema,
  type BlobReferenceRow,
  type ReferenceSyntacticForm,
} from '../schemas/projection-blobs.js';
import type { LinkNodeType, ResourceLink } from '../schemas/resource-metadata.js';

/**
 * The forms {@link syntacticFormFor} can assign — every `ReferenceSyntacticForm`
 * the raw-source lexer does **not** claim for itself.
 *
 * Derived by subtracting one producer's enum from the whole, never hand-listed.
 * A hand-listed copy is precisely what went wrong: the whole-corpus population
 * test carried its own `MARKDOWN_FORMS` triple and used
 * `blobs.linkCount - (rows in that set)` as an independent measurement of
 * "AST links dropped for want of a span". That subtraction was right only while
 * mdast was the only producer whose links reached a row. Giving HTML links a
 * span — and their own `html-link` form — made every one of them look dropped
 * to that derivation, and the two measurements disagreed by exactly the number
 * of HTML references in the corpus (4).
 *
 * So the partition is stated **here**, beside the only function that assigns an
 * AST form, and consumers read it. Add a fourth parser and its form is counted
 * as AST-derived the moment it joins `ReferenceSyntacticFormSchema`; add a
 * lexer form and it must join `LexicalSyntacticFormSchema`, which is what
 * `LexicalReference.syntacticForm` is typed by, so the lexer cannot emit one
 * without moving this set with it.
 *
 * Why the lexer's half is the one subtracted, rather than the AST's half
 * listed: the forms a parser's `links` produce are exactly the rows a resource's
 * links are rebuilt from, and the lexer is the one producer whose forms are not
 * links; this constant names that population once.
 */
export const AST_SYNTACTIC_FORMS: ReadonlySet<ReferenceSyntacticForm> = new Set(
  ReferenceSyntacticFormSchema.options.filter(
    (form): boolean => !(LexicalSyntacticFormSchema.options as readonly string[]).includes(form),
  ),
);

/** The row columns a `LexicalReference` supplies directly, under the same names. */
type LexicalColumns = Omit<BlobReferenceRow, 'blob' | 'ordinal' | 'rawRef' | 'text' | 'astIndex'>;

/**
 * `Omit<LexicalReference, 'raw'>` — but only while its key set is *exactly*
 * {@link LexicalColumns}'.
 *
 * The lexer's columns are copied by spread rather than one assignment per
 * field, and TypeScript does **not** excess-property-check a spread (measured,
 * not assumed). So without this, a new `LexicalReference` field would be spread
 * silently into a `.strict()` row and fail at Zod parse time, in production,
 * far from the change that caused it. When the two key sets diverge in either
 * direction this resolves to `never` and {@link lexicalColumnsOf} stops
 * compiling — which is also the right place to notice a new *row* column,
 * since someone has to decide which producer fills it.
 *
 * Key parity, not type parity: `column` widens to `number | null` on the row
 * and `syntacticForm` widens to include the three markdown forms, so the types
 * are deliberately not equal.
 */
type ExactLexicalColumns =
  keyof Omit<LexicalReference, 'raw'> extends keyof LexicalColumns
    ? keyof LexicalColumns extends keyof Omit<LexicalReference, 'raw'>
      ? Omit<LexicalReference, 'raw'>
      : never
    : never;

/** A candidate with its sort key, before ordinals are assigned. */
interface OrderedCandidate {
  /** The row's line, or null for a reference whose node carries no position: it sorts after every positioned one. */
  line: number | null;
  column: number | null;
  /**
   * Tie-break within the same `(line, column)` — what decides order among
   * candidates `line` and `column` alone cannot separate.
   *
   * NOT one meaning across producers, deliberately:
   *
   * - A markdown AST link's tie-break is its index in `links` — preserving
   *   the kind-order bucket contract (`link`, then `linkReference`, then
   *   `definition`) the module header documents and the parse-fact goldens
   *   pin by ordinal. That order is document position ONLY within a bucket;
   *   across buckets it is deliberately not source order.
   * - An HTML AST link's tie-break is its own `startOffset` — see
   *   {@link astCandidates} for why DOM/walk order (foster parenting) cannot
   *   be trusted here the way it can for markdown's `links` array.
   * - A lexer token's tie-break is its index in `lexicalReferences`, which
   *   IS document order (the lexer is a single raw-source scan).
   */
  tieBreak: number;
  row: Omit<BlobReferenceRow, 'ordinal'>;
}

/**
 * Derive the `blob_references` rows for one blob.
 *
 * ## Every link is a row, positioned or not
 *
 * `ResourceLink.line` and its offsets are optional, and a GFM autolink literal
 * glued to text (`domain:www.example.com`) really arrives with none. Such a link
 * is still a link the resource carries, so it is stored with null position
 * columns — never defaulted to line 1, where it would pile onto the top of the
 * document, and never skipped, which left a resource rebuilt from these rows
 * one link short of the parse it came from. One row per link is what lets
 * `blobs.linkCount` cross-check the rows: the AST-derived rows of a blob number
 * exactly its `linkCount`.
 *
 * `astIndex` records each AST row's position in the parser's own `links`, so
 * the links are rebuilt in the parser's order whatever order `ordinal` gives
 * the rows.
 *
 * @param contentKey - The blob's content key, as `computeContentKey` produces it
 * @param parsed - The parse result whose `links` and `lexicalReferences` are unified
 * @returns One row per candidate, ordered by `(line, column)`, the position-less last
 */
export function blobReferencesFor(contentKey: string, parsed: ParseResult): BlobReferenceRow[] {
  const candidates: OrderedCandidate[] = [
    ...astCandidates(contentKey, parsed.links),
    ...lexicalCandidates(contentKey, parsed.lexicalReferences ?? []),
  ];

  candidates.sort(compareCandidates);

  return candidates.map(({ row }, ordinal) => ({ ...row, ordinal }));
}

/**
 * Order by line, then by column with a null column first, then by
 * {@link OrderedCandidate.tieBreak}.
 *
 * @param left - First candidate
 * @param right - Second candidate
 * @returns Negative, zero or positive, as `Array#sort` expects
 */
function compareCandidates(left: OrderedCandidate, right: OrderedCandidate): number {
  if (left.line !== right.line) {
    // A reference with no position cannot be placed among positioned ones, so
    // it goes after all of them, in its producer's own order (`tieBreak`).
    if (left.line === null) return 1;
    if (right.line === null) return -1;
    return left.line - right.line;
  }
  // A null column is "somewhere on this line" and cannot be placed among the
  // known columns, so it is placed first — stated, rather than left to
  // whatever a numeric comparison does with null.
  if (left.column === null || right.column === null) {
    if (left.column !== right.column) return left.column === null ? -1 : 1;
  } else if (left.column !== right.column) {
    return left.column - right.column;
  }
  return left.tieBreak - right.tieBreak;
}

/**
 * Candidates from a parser's link rows.
 *
 * ⛔ This said "from the markdown AST's link rows" — markdown-only reasoning of
 * exactly the kind that let the HTML under-report below through. `links` is
 * filled by whichever parser handled the blob (mdast for markdown, parse5 for
 * HTML), and the kind-order contract in the module header is markdown's alone:
 * parse5 emits links in document order, every one of them `htmlAttribute`.
 *
 * ⛔ "In document order" was also wrong, in a way inert until `ordinal` had
 * anything HTML to order: parse5's `links` order is DOM/walk order
 * (`walkElements`'s depth-first traversal of the PARSED tree), and HTML's
 * foster-parenting rule can MOVE a node — an `<a>`/text not permitted directly
 * inside a `<table>` is re-parented to just before it, so the moved link is
 * walked BEFORE a link that is textually earlier in the source. When both land
 * on the same `line` (foster parenting does not change which line a node's own
 * start tag is on), DOM order and source order disagree and `line` alone
 * cannot separate them — see the module header and `B1` in
 * `projection-blob-references.test.ts` for the measured shapes. So an
 * `htmlAttribute` link's tie-break is its own `startOffset`, not its `links`
 * index; a markdown link's tie-break stays its `links` index, since THAT order
 * is the kind-order bucket contract, not source order, and must not become
 * source order by riding along with this fix.
 *
 * @param contentKey - The blob's content key
 * @param links - `ParseResult.links`, in the producing parser's own order
 * @returns One candidate per link, positioned or not
 */
function astCandidates(contentKey: string, links: readonly ResourceLink[]): OrderedCandidate[] {
  return links.map<OrderedCandidate>((link, sequence) => ({
    // A position-less link is a row too (null line and span): see
    // {@link blobReferencesFor}. Its line and its offsets are read
    // independently, because the producers fill them independently: the HTML
    // parser has emitted a line with no offsets.
    line: link.line ?? null,
    column: null,
    // htmlAttribute: tie-break by real source position (immune to DOM/foster-
    // parenting order). Anything else (markdown, or a producer that did not
    // say), and a link with no offset: tie-break by `links` index, preserving
    // the kind-order bucket contract — see this function's docstring.
    tieBreak: link.nodeType === 'htmlAttribute' && link.startOffset !== undefined ? link.startOffset : sequence,
    row: {
      blob: contentKey,
      rawRef: link.href,
      text: link.text,
      line: link.line ?? null,
      column: null,
      ...spanOf(link),
      astIndex: sequence,
      syntacticForm: syntacticFormFor(link.nodeType),
      ...lexicalFeatures(link.href),
      // A link inside a fence or a code span is not parsed as a link at all
      // — it is a `code`/`inlineCode` node — so an AST-derived row is never
      // in either context.
      inCodeSpan: false,
      inFence: false,
    },
  }));
}

/**
 * A link's span columns, each exactly as the parser supplied it: an absent offset
 * is `null`, never a guess, so the fact reader rebuilds the link the parser made.
 *
 * @param link - One parser-supplied link
 * @returns The row's two offset columns
 */
function spanOf(link: ResourceLink): Pick<BlobReferenceRow, 'startOffset' | 'endOffset'> {
  return { startOffset: link.startOffset ?? null, endOffset: link.endOffset ?? null };
}

/**
 * Candidates from the raw-source lexer.
 *
 * Every lexical column is carried through unchanged: the lexer is the only
 * producer that can observe them, so re-deriving any of them here would be a
 * second opinion nothing reconciles.
 *
 * @param contentKey - The blob's content key
 * @param references - `ParseResult.lexicalReferences`, in document order
 * @returns One candidate per lexical reference
 */
function lexicalCandidates(
  contentKey: string,
  references: readonly LexicalReference[],
): OrderedCandidate[] {
  return references.map((reference, sequence) => ({
    line: reference.line,
    column: reference.column,
    tieBreak: sequence,
    row: lexicalRow(contentKey, reference),
  }));
}

/**
 * One row from one lexer token.
 *
 * `raw` is renamed to `rawRef` and everything else is carried through by
 * spread, checked by {@link ExactLexicalColumns} on the way past.
 *
 * @param contentKey - The blob's content key
 * @param reference - One lexer token
 * @returns The row, less its ordinal
 */
function lexicalRow(contentKey: string, reference: LexicalReference): Omit<BlobReferenceRow, 'ordinal'> {
  const { raw, ...columns } = reference;
  const checked: ExactLexicalColumns = columns;

  return {
    blob: contentKey,
    rawRef: raw,
    // A lexer token has no link text — there is no markup to carry one.
    text: null,
    // Nor a place in a parser's links: it is not one.
    astIndex: null,
    ...checked,
  };
}

/**
 * Map an AST node type onto its syntactic form.
 *
 * An `if`/`else if` chain rather than a `switch`:
 * `@typescript-eslint/switch-exhaustiveness-check` requires a switch over a
 * union to name every member even with a `default`, and the absent case is not
 * a member of the union at all.
 *
 * ⛔ The absent case used to be the HTML parser's, which emitted links with no
 * `nodeType` and so collected the `markdown-link` default. That was wrong and
 * INERT at the same time: every HTML link was dropped by {@link astCandidates}
 * for want of a span, so the mislabel described a population of zero and no
 * test could see it. Giving HTML rows a span is exactly what would have made it
 * load-bearing — `markdown-link` is followed by `closure-extent`'s default
 * `follow` and by `claude-context-discovery`'s `FOLLOWED_FORMS`, so
 * `vat inventory` would have begun reporting members `vat build` does not
 * bundle. The parser now states `htmlAttribute` and this maps it to its own
 * form, which neither list follows.
 *
 * The remaining absent case is a producer that did not say. It keeps
 * `markdown-link` because mdast is the only other producer feeding this
 * function, and every mdast inline link arrives as `'link'` — but the default
 * is now a fallback nothing shipped relies on, rather than a live path.
 *
 * @param nodeType - `ResourceLink.nodeType`, possibly absent
 * @returns The matching syntactic form, defaulting an absent node type to `markdown-link`
 */
function syntacticFormFor(nodeType: LinkNodeType | undefined): ReferenceSyntacticForm {
  if (nodeType === 'linkReference') return 'markdown-link-reference';
  if (nodeType === 'definition') return 'markdown-definition';
  if (nodeType === 'htmlAttribute') return 'html-link';
  return 'markdown-link';
}

/**
 * The four purely lexical columns, derived from a raw reference string.
 *
 * `hasExtension` is {@link EXTENSION_SUFFIX} tested against
 * {@link stripQueryOrFragment}'s result — both imported from `reference-lexer.ts`, which is
 * also where the lexer's own `hasExtension` column (`emitToken`) tests the same two symbols.
 * One shared predicate, not two coincidentally-identical ones: see `EXTENSION_SUFFIX`'s
 * docstring there for the ⛔ history of what went wrong while they were separate copies.
 *
 * @param rawRef - The reference exactly as authored
 * @returns The lexical feature columns of a `blob_references` row
 */
function lexicalFeatures(rawRef: string): Pick<
  BlobReferenceRow,
  'hasExtension' | 'leadingAt' | 'slashCount' | 'variableExpansion'
> {
  let slashCount = 0;
  for (const char of rawRef) if (char === '/') slashCount++;

  return {
    hasExtension: EXTENSION_SUFFIX.test(stripQueryOrFragment(rawRef)),
    leadingAt: rawRef.startsWith('@'),
    slashCount,
    variableExpansion: detectVariableExpansion(rawRef),
  };
}

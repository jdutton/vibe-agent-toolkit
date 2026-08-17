/**
 * Blob-keyed reference rows — every reference *candidate* a blob contains,
 * from both of the two producers that can find one.
 *
 * The markdown AST produces `links`; the raw-source lexer produces
 * `lexicalReferences`. They see disjoint populations by construction — the
 * lexer's excluded ranges cover exactly the AST node kinds that already emit a
 * link row — so the union is a partition, not a merge with overlap.
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
 * ## What is deliberately NOT carried
 *
 * `ResourceLink.resolvedId` is the one field production code mutates **after**
 * the parse — `skill-packager` assigns it while bundling. A blob-keyed row is
 * content-addressed, so carrying `resolvedId` would make a blob fact depend on
 * which skill happened to be packaged first. The blob layer stores shape;
 * meaning belongs to a lens (resource-projection.md §5).
 */

import type { ParseResult } from '../link-parser.js';
import { detectVariableExpansion, type LexicalReference } from '../reference-lexer.js';
import type { BlobReferenceRow, ReferenceSyntacticForm } from '../schemas/projection-blobs.js';
import type { LinkNodeType, ResourceLink } from '../schemas/resource-metadata.js';

/**
 * A dot followed by a short alphanumeric run at the very end of the token.
 *
 * Deliberately the same rule `reference-lexer.ts` applies to its own tokens:
 * `hasExtension` must mean one thing across the table, or a query filtering on
 * it silently reads two different predicates depending on which producer
 * emitted the row.
 */
const EXTENSION_SUFFIX = /\.[A-Za-z0-9]{1,8}$/u;

/** The row columns a `LexicalReference` supplies directly, under the same names. */
type LexicalColumns = Omit<BlobReferenceRow, 'blob' | 'ordinal' | 'rawRef' | 'text'>;

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
  line: number;
  column: number | null;
  /** Position within the producing sequence — breaks ties without reordering. */
  sequence: number;
  row: Omit<BlobReferenceRow, 'ordinal'>;
}

/**
 * Derive the `blob_references` rows for one blob.
 *
 * ## References with no line are skipped, not defaulted
 *
 * `ResourceLink.line` is optional; `BlobReferenceRow.line` is required and
 * `positive()`. Defaulting an absent line to 1 would pile every position-less
 * reference onto the top of the document, where no assertion could ever catch
 * it — the same rule `blob-sections.ts` applies to position-less headings.
 * Remark always supplies a position, so in practice none are skipped; "in
 * practice" is not a type.
 *
 * @param contentKey - The blob's content key, as `computeContentKey` produces it
 * @param parsed - The parse result whose `links` and `lexicalReferences` are unified
 * @returns One row per positioned candidate, ordered by `(line, column)`
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
 * Order by line, then by column with a null column first, then by the
 * producing sequence.
 *
 * @param left - First candidate
 * @param right - Second candidate
 * @returns Negative, zero or positive, as `Array#sort` expects
 */
function compareCandidates(left: OrderedCandidate, right: OrderedCandidate): number {
  if (left.line !== right.line) return left.line - right.line;
  // A null column is "somewhere on this line" and cannot be placed among the
  // known columns, so it is placed first — stated, rather than left to
  // whatever a numeric comparison does with null.
  if (left.column === null || right.column === null) {
    if (left.column !== right.column) return left.column === null ? -1 : 1;
  } else if (left.column !== right.column) {
    return left.column - right.column;
  }
  return left.sequence - right.sequence;
}

/**
 * Candidates from the markdown AST's link rows.
 *
 * @param contentKey - The blob's content key
 * @param links - `ParseResult.links`, in the parser's kind order
 * @returns One candidate per positioned link
 */
function astCandidates(contentKey: string, links: readonly ResourceLink[]): OrderedCandidate[] {
  return links.flatMap<OrderedCandidate>((link, sequence) => {
    // Both halves of the position, and both required — the row's span columns
    // are non-nullable, so a link whose node carried no offsets is skipped here
    // exactly as a link with no line is, and counted by the same difference
    // `emitBlobRows` takes. mdast fills the two together, so this admits and
    // rejects the same population the line check alone did.
    if (link.line === undefined || link.startOffset === undefined || link.endOffset === undefined) {
      return [];
    }
    return [{
      line: link.line,
      column: null,
      sequence,
      row: {
        blob: contentKey,
        rawRef: link.href,
        text: link.text,
        line: link.line,
        column: null,
        startOffset: link.startOffset,
        endOffset: link.endOffset,
        syntacticForm: syntacticFormFor(link.nodeType),
        ...lexicalFeatures(link.href),
        // A link inside a fence or a code span is not parsed as a link at all
        // — it is a `code`/`inlineCode` node — so an AST-derived row is never
        // in either context.
        inCodeSpan: false,
        inFence: false,
      },
    }];
  });
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
    sequence,
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
    ...checked,
  };
}

/**
 * Map an AST node type onto its syntactic form.
 *
 * An `if`/`else if` chain rather than a `switch`:
 * `@typescript-eslint/switch-exhaustiveness-check` requires a switch over a
 * union to name every member even with a `default`, and the absent case —
 * which the HTML parser produces, since it emits links with no `nodeType` —
 * is not a member of the union at all.
 *
 * @param nodeType - `ResourceLink.nodeType`, possibly absent
 * @returns The matching syntactic form, defaulting an absent node type to `markdown-link`
 */
function syntacticFormFor(nodeType: LinkNodeType | undefined): ReferenceSyntacticForm {
  if (nodeType === 'linkReference') return 'markdown-link-reference';
  if (nodeType === 'definition') return 'markdown-definition';
  return 'markdown-link';
}

/**
 * The four purely lexical columns, derived from a raw reference string.
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
    hasExtension: EXTENSION_SUFFIX.test(rawRef),
    leadingAt: rawRef.startsWith('@'),
    slashCount,
    variableExpansion: detectVariableExpansion(rawRef),
  };
}

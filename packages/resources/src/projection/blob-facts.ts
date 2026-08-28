/**
 * Blob-keyed facts derived from one parse: measurements that are a function of
 * the bytes alone.
 *
 * Everything here belongs in the content-addressed parse cache by the same rule
 * as `estimatedTokenCount` — the same bytes always produce the same answer, so
 * a path never enters the derivation.
 */

import type { TextProvenance } from '@vibe-agent-toolkit/utils/text';

import type { ParseResult } from '../link-parser.js';
import type { OffsetRange } from '../reference-lexer.js';
import type { ContentMeasures } from '../schemas/parse-facts.js';
import type { BlobConditionRow, BlobRow } from '../schemas/projection-blobs.js';

import { flattenHeadings } from './blob-sections.js';

// `ContentMeasures` is defined by `ContentMeasuresSchema`
// (`schemas/parse-facts.ts`), not here: the parse cache persists these three
// counts and validates them on read, so the shape needs one definition.

/**
 * Split a document into prose and code blocks by size, and count prose words.
 *
 * The two size counts partition the content exactly — `proseCodeUnits +
 * codeBlockCodeUnits === content.length` — which is the invariant that makes a
 * measurement trustworthy rather than approximate. Ranges are merged before
 * summing, because a range list is a set of spans and two overlapping spans
 * cover their union, not the sum of their lengths.
 *
 * ## What "code" means here, exactly
 *
 * Whatever the caller puts in `fences`, and `codeContextRangesFrom` fills that
 * array from every `code-block` span — which is **fenced and indented code
 * blocks alike**, since the span vocabulary gives both the same kind. "Fenced"
 * would name only half of what is actually excluded.
 *
 * **Inline code is NOT excluded.** `codeContextRangesFrom` files `code-span`
 * spans into a separate `codeSpans` array, and no caller ever passes that array
 * here — so a `` `token` `` in a sentence counts as prose, in both the size
 * count and the word count. That is a property of the wiring rather than a
 * decision this function makes, which is exactly why it has to be written down:
 * the name `codeBlockCodeUnits` is true and the intuition "code is excluded" is
 * not.
 *
 * Both counts are **UTF-16 code units**, which is what the names say and what
 * the arithmetic already produces: `fences` are code-unit offsets into the
 * decoded JS string, so `end - start` is a code-unit count and `content.length`
 * is the code-unit total. No scan and no allocation — the whole measurement is
 * arithmetic on offsets the parse already handed us. A code-point count would
 * cost an O(n) spread per document to buy a unit nothing downstream indexes in;
 * `BlobRow.bytes` carries the on-disk byte count for callers who want bytes.
 *
 * @param content - Decoded document text
 * @param fences - Code-block offset ranges (UTF-16 code units), from
 *   `codeContextRangesFrom` — fenced and indented blocks, never inline spans
 * @returns The three measures
 */
export function measureContent(content: string, fences: readonly OffsetRange[]): ContentMeasures {
  const merged = mergeRanges(fences, content.length);
  let codeBlockCodeUnits = 0;
  const proseSegments: string[] = [];
  let cursor = 0;

  for (const [start, end] of merged) {
    if (start > cursor) proseSegments.push(content.slice(cursor, start));
    // `end - start` on code-unit offsets IS the code-unit count — the column is
    // named for the unit the offsets are already in, so nothing has to be
    // re-measured.
    codeBlockCodeUnits += end - start;
    cursor = end;
  }
  if (cursor < content.length) proseSegments.push(content.slice(cursor));

  // Joined with a space so two segments separated only by a fence cannot fuse
  // into one word.
  const prose = proseSegments.join(' ');
  return {
    wordCount: prose.split(/\s+/u).filter((word) => word.length > 0).length,
    // The partition invariant, in code units on both sides.
    proseCodeUnits: content.length - codeBlockCodeUnits,
    codeBlockCodeUnits,
  };
}

/**
 * `TextProvenance` — but only while the `blobs` row's `encoding` column admits
 * *exactly* the encodings the decoder can produce.
 *
 * `BlobEncodingSchema` restates `TextEncoding` as a Zod enum because a stored
 * column needs a runtime validator, and two spellings of one closed set is the
 * shape that drifts. This alias resolves to `never` in either direction of
 * divergence — the decoder gaining an encoding the column cannot store, or the
 * column gaining one nothing produces — and {@link blobRowFor} then stops
 * compiling, which is the only notification that does not depend on someone
 * reading a comment.
 *
 * `encodingSource` needs no such guard: it is assigned by name below, so a
 * mismatch is an ordinary type error at the assignment.
 */
type ExactBlobEncoding =
  TextProvenance['encoding'] extends BlobRow['encoding']
    ? BlobRow['encoding'] extends TextProvenance['encoding']
      ? TextProvenance
      : never
    : never;

/**
 * Build the `blobs` row for one parse.
 *
 * Every column is a function of the bytes alone, so the row is safe to cache
 * content-addressed alongside `estimatedTokenCount`. That includes the three
 * decode columns: which encoding a byte string announces, and what decoding it
 * under that encoding costs, are properties of the bytes and of nothing else.
 *
 * `sizeBytes` is a parameter rather than `parsed.content.length` on purpose:
 * decoding is many-to-one on malformed UTF-8, so the raw on-disk byte count and
 * the decoded string length legitimately diverge. `ParseFactRow` records both
 * for the same reason. The caller passes its `stat().size`.
 *
 * `decoding` is a parameter for a stronger version of that reason: it is not
 * recoverable from `parsed` **at all**. A `ParseResult` describes a JS string,
 * and by then the encoding question has already been answered and thrown away —
 * which is precisely the silence these columns exist to end.
 *
 * @param contentKey - The blob's `<parserKind>.<sha256>` key
 * @param sizeBytes - Raw on-disk byte length, from the caller's `stat()`
 * @param decoding - What the decode of these bytes knew, guessed and lost,
 *   straight off the `KeyedContent` the parse was performed on
 * @param parsed - The parse this row describes
 * @returns The `blobs` row
 */
export function blobRowFor(
  contentKey: string,
  sizeBytes: number,
  decoding: ExactBlobEncoding,
  parsed: ParseResult,
): BlobRow {
  const measures = parsed.contentMeasures;
  // One section per heading, so both columns come from the same count. The
  // heading list is a TREE (`buildHeadingTree`), so `.length` alone counts only
  // roots — hence `flattenHeadings`, which is the SAME walk `blobSectionsFor`
  // runs. Deliberately shared rather than re-implemented here: two walkers over
  // one tree is the shape that drifts, and `blobs.sectionCount ===
  // count(blob_sections)` is then true by construction instead of by
  // coincidence. (It held by coincidence until 2026-08-13, when a private
  // `countHeadings` here was deleted in favour of this call.)
  const headingCount = flattenHeadings(parsed.headings).length;

  return {
    contentKey,
    bytes: sizeBytes,
    encoding: decoding.encoding,
    encodingSource: decoding.encodingSource,
    replacementCharacters: decoding.replacementCharacters,
    tokenEstimate: parsed.estimatedTokenCount,
    // `ParseResult` types frontmatter values as `unknown` — YAML can decode to
    // `Infinity`, `NaN` or a `Buffer`, none of which are JSON. The projection
    // schema is the enforcement point for that, not this assembler: narrowing
    // here would have to either drop or invent values.
    frontmatter: (parsed.frontmatter ?? null) as BlobRow['frontmatter'],
    frontmatterError: parsed.frontmatterError ?? null,
    wordCount: measures?.wordCount ?? 0,
    proseCodeUnits: measures?.proseCodeUnits ?? 0,
    codeBlockCodeUnits: measures?.codeBlockCodeUnits ?? 0,
    linkCount: parsed.links.length,
    headingCount,
    sectionCount: headingCount,
  };
}

/**
 * Build the `blob_conditions` rows for one parse.
 *
 * Both sources are optional on `ParseResult` — HTML leaves
 * `unresolvedReferences` undefined, markdown leaves `parseErrors` undefined —
 * and absent collapses to empty here deliberately: at the condition layer
 * "nothing to say" and "nothing found" are the same row set.
 *
 * `code` is an open vocabulary (resource-projection.md §2), so classifying a
 * new diagnostic adds rows, never columns.
 *
 * @param contentKey - The blob's key, written into every row's `blob` column
 * @param parsed - The parse whose diagnostics become rows
 * @returns Zero or more condition rows, HTML parse errors first
 */
export function blobConditionsFor(contentKey: string, parsed: ParseResult): BlobConditionRow[] {
  const rows: BlobConditionRow[] = [];

  for (const error of parsed.parseErrors ?? []) {
    rows.push({
      blob: contentKey,
      code: 'HTML_PARSE_ERROR',
      severity: 'warning',
      // Already a parse5 error code, e.g. "missing-end-tag" — not prose.
      message: error.message,
      // `HtmlParseError.line` is optional; the row's column is `number | null`.
      line: error.line ?? null,
    });
  }

  for (const reference of parsed.unresolvedReferences ?? []) {
    rows.push({
      blob: contentKey,
      code: 'UNRESOLVED_REFERENCE',
      severity: 'warning',
      // The label as authored — the code already carries the meaning.
      message: reference.label,
      line: reference.line,
    });
  }

  return rows;
}

/**
 * Sort, clamp to the content and coalesce overlapping ranges.
 *
 * @param ranges - Raw ranges, in any order, possibly overlapping
 * @param limit - Content length; every range is clamped into `[0, limit]`
 * @returns Disjoint ranges in ascending order
 */
function mergeRanges(ranges: readonly OffsetRange[], limit: number): OffsetRange[] {
  const clamped = ranges
    .map(([start, end]): OffsetRange => [Math.max(0, start), Math.min(limit, end)])
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);

  const merged: OffsetRange[] = [];
  for (const range of clamped) {
    const last = merged.at(-1);
    if (last !== undefined && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([range[0], range[1]]);
    }
  }
  return merged;
}

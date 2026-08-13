/**
 * Blob-keyed facts derived from one parse: measurements that are a function of
 * the bytes alone.
 *
 * Everything here belongs in the content-addressed parse cache by the same rule
 * as `estimatedTokenCount` — the same bytes always produce the same answer, so
 * a path never enters the derivation.
 */

import type { ParseResult } from '../link-parser.js';
import type { OffsetRange } from '../reference-lexer.js';
import type { BlobConditionRow, BlobRow } from '../schemas/projection-blobs.js';

import { flattenHeadings } from './blob-sections.js';

/** Byte and word accounting for one blob, split by code context. */
export interface ContentMeasures {
  /** Whitespace-delimited words outside fenced code. */
  wordCount: number;
  /** Characters outside fenced code. */
  proseBytes: number;
  /** Characters inside fenced code. */
  codeBlockBytes: number;
}

/**
 * Split a document's characters into prose and fenced code, and count prose words.
 *
 * The two byte counts partition the content exactly — `proseBytes +
 * codeBlockBytes === content.length` — which is the invariant that makes a
 * measurement trustworthy rather than approximate. Ranges are merged before
 * summing, because a range list is a set of spans and two overlapping spans
 * cover their union, not the sum of their lengths.
 *
 * Both counts are in UTF-16 code units, not bytes on disk: the input is a
 * decoded string, and decoding is many-to-one on malformed UTF-8. `BlobRow.bytes`
 * carries the on-disk count separately for exactly that reason.
 *
 * @param content - Decoded document text
 * @param fences - Fenced-code offset ranges, from `collectCodeContextRanges`
 * @returns The three measures
 */
export function measureContent(content: string, fences: readonly OffsetRange[]): ContentMeasures {
  const merged = mergeRanges(fences, content.length);
  let codeBlockBytes = 0;
  const proseSegments: string[] = [];
  let cursor = 0;

  for (const [start, end] of merged) {
    if (start > cursor) proseSegments.push(content.slice(cursor, start));
    codeBlockBytes += end - start;
    cursor = end;
  }
  if (cursor < content.length) proseSegments.push(content.slice(cursor));

  // Joined with a space so two segments separated only by a fence cannot fuse
  // into one word.
  const prose = proseSegments.join(' ');
  return {
    wordCount: prose.split(/\s+/u).filter((word) => word.length > 0).length,
    proseBytes: content.length - codeBlockBytes,
    codeBlockBytes,
  };
}

/**
 * Build the `blobs` row for one parse.
 *
 * Every column is a function of the bytes alone, so the row is safe to cache
 * content-addressed alongside `estimatedTokenCount`.
 *
 * `sizeBytes` is a parameter rather than `parsed.content.length` on purpose:
 * decoding is many-to-one on malformed UTF-8, so the raw on-disk byte count and
 * the decoded string length legitimately diverge. `ParseFactRow` records both
 * for the same reason. The caller passes its `stat().size`.
 *
 * @param contentKey - The blob's `<parserKind>.<sha256>` key
 * @param sizeBytes - Raw on-disk byte length, from the caller's `stat()`
 * @param parsed - The parse this row describes
 * @returns The `blobs` row
 */
export function blobRowFor(contentKey: string, sizeBytes: number, parsed: ParseResult): BlobRow {
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
    tokenEstimate: parsed.estimatedTokenCount,
    // `ParseResult` types frontmatter values as `unknown` — YAML can decode to
    // `Infinity`, `NaN` or a `Buffer`, none of which are JSON. The projection
    // schema is the enforcement point for that, not this assembler: narrowing
    // here would have to either drop or invent values.
    frontmatter: (parsed.frontmatter ?? null) as BlobRow['frontmatter'],
    frontmatterError: parsed.frontmatterError ?? null,
    wordCount: measures?.wordCount ?? 0,
    proseBytes: measures?.proseBytes ?? 0,
    codeBlockBytes: measures?.codeBlockBytes ?? 0,
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

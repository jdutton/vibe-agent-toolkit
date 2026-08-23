/**
 * Blob-keyed section rows — the heading tree, flattened into document order.
 *
 * `ParseResult.headings` is a *tree*: children nest under the preceding heading
 * of a lower level. Every column of `blob_sections` is a document-order fact
 * (`ordinal`, `parentOrdinal`, `lineEnd`), so this module flattens first and
 * then re-encodes the tree as `ordinal` + `parentOrdinal`. That encoding is what
 * lets a query ask "which sections moved" without diffing a nested rendering,
 * where one heading changing level relocates its whole subtree.
 *
 * Path never enters the derivation: the same bytes always produce the same rows,
 * which is what makes these facts blob-keyed rather than realization-keyed.
 */

import GithubSlugger from 'github-slugger';

import { estimateTokens } from '../link-parser.js';
import type { BlobSectionRow } from '../schemas/projection-blobs.js';
import type { HeadingNode } from '../schemas/resource-metadata.js';

/**
 * Flatten the heading tree into document order.
 *
 * `HeadingNode` nests children, which is the right shape for a table of
 * contents and the wrong shape for tabulation or diffing. Flat plus an explicit
 * `level` says what actually changed.
 *
 * @param headings - Top-level heading nodes, as `ParseResult.headings` carries them
 * @returns The same nodes, in document order, with no nesting
 */
export function flattenHeadings(headings: readonly HeadingNode[]): HeadingNode[] {
  const flat: HeadingNode[] = [];
  const walk = (nodes: readonly HeadingNode[]): void => {
    for (const node of nodes) {
      flat.push(node);
      if (node.children !== undefined) {
        walk(node.children);
      }
    }
  };
  walk(headings);
  return flat;
}

/** A flattened heading that carries a source position, with that position narrowed to `number`. */
interface PositionedHeading {
  node: HeadingNode;
  line: number;
}

/** An enclosing heading still open at the current point in the document. */
interface OpenAncestor {
  ordinal: number;
  level: number;
}

/**
 * Derive the `blob_sections` rows for one blob.
 *
 * ## Two columns that are not what they look like
 *
 * **`slug` is not `HeadingNode.slug`.** The parser slugs headings with a
 * *stateful* `GithubSlugger`, so a second "Usage" arrives already carrying
 * GitHub's occurrence suffix — `usage-1`, not `usage`. The schema wants the bare
 * slug in `slug` and the occurrence number in `slugOccurrence`, so this re-slugs
 * each title with a **fresh, single-use** slugger: a slugger with no dedupe
 * state never suffixes. Stripping a trailing `-N` by regex instead would report
 * a heading legitimately titled "Step 1" as occurrence 1 of a section named
 * "step".
 *
 * **`lineEnd` runs to the next heading of level ≤ this one**, not to the next
 * heading of any level. That is what makes `bytes` span nested subsections, as
 * `BlobSectionRowSchema` documents — a nested subsection is therefore counted
 * twice across the table, once in its own row and once in each ancestor's.
 *
 * ## Headings with no position are skipped, not defaulted
 *
 * `HeadingNode.line` is optional; `lineStart` is required and positive. Remark
 * always supplies a position, so in practice none are skipped — but "in
 * practice" is not a type, and defaulting to line 1 would silently pile every
 * position-less section onto the top of the document where nothing could
 * falsify it.
 *
 * @param contentKey - The blob's content key, as `computeContentKey` produces it
 * @param content - The decoded document text the headings were parsed from
 * @param headings - The heading tree, as `ParseResult.headings` carries it
 * @returns One row per positioned heading, in document order
 */
export function blobSectionsFor(
  contentKey: string,
  content: string,
  headings: readonly HeadingNode[],
): BlobSectionRow[] {
  const positioned = positionedHeadings(headings);
  if (positioned.length === 0) return [];

  const lineStarts = lineStartOffsets(content);
  const occurrences = new Map<string, number>();
  const openAncestors: OpenAncestor[] = [];
  const rows: BlobSectionRow[] = [];

  for (const [ordinal, { node, line }] of positioned.entries()) {
    const lineEnd = sectionEndLine(positioned, ordinal, lineStarts.length);
    const slug = new GithubSlugger().slug(node.text);
    const slugOccurrence = occurrences.get(slug) ?? 0;
    occurrences.set(slug, slugOccurrence + 1);

    while ((openAncestors.at(-1)?.level ?? 0) >= node.level) openAncestors.pop();
    const parentOrdinal = openAncestors.at(-1)?.ordinal ?? null;
    openAncestors.push({ ordinal, level: node.level });

    const body = content.slice(
      lineStarts[line - 1] ?? content.length,
      lineStarts[lineEnd] ?? content.length,
    );

    rows.push({
      blob: contentKey,
      ordinal,
      depth: node.level,
      title: node.text,
      slug,
      slugOccurrence,
      parentOrdinal,
      lineStart: line,
      lineEnd,
      // A real UTF-8 byte count, not `body.length` — this is a size rather than
      // an index, and it differs from the code-unit length for any non-ASCII
      // body. The spans a rewriter uses are `startOffset`/`endOffset` on
      // references, which stay UTF-16 code units.
      bytes: Buffer.byteLength(body, 'utf-8'),
      tokens: estimateTokens(body),
    });
  }

  return rows;
}

/**
 * Flatten, then drop the headings that carry no source position.
 *
 * @param headings - The heading tree
 * @returns Document-order headings whose `line` is known
 */
function positionedHeadings(headings: readonly HeadingNode[]): PositionedHeading[] {
  return flattenHeadings(headings).flatMap<PositionedHeading>((node) =>
    node.line === undefined ? [] : [{ node, line: node.line }],
  );
}

/**
 * Last line this section owns: the line before the next heading of level ≤ its
 * own, or the last line of the document.
 *
 * Clamped to `lineStart` so a degenerate input — two headings claiming the same
 * line — cannot produce a `lineEnd` below `lineStart`, which the schema's
 * `positive()` would reject at the top of a document.
 *
 * @param positioned - All positioned headings, in document order
 * @param ordinal - Index of the section being closed
 * @param lineCount - Number of lines in the document
 * @returns 1-based last line of the section
 */
function sectionEndLine(
  positioned: readonly PositionedHeading[],
  ordinal: number,
  lineCount: number,
): number {
  const current = positioned[ordinal];
  if (current === undefined) return lineCount;

  const next = positioned
    .slice(ordinal + 1)
    .find((candidate) => candidate.node.level <= current.node.level);

  return Math.max(current.line, next === undefined ? lineCount : next.line - 1);
}

/**
 * Offset of the first character of every line.
 *
 * Index `i` holds the offset of line `i + 1`, so the end of line `n` is the
 * start of line `n + 1` — including that line's own newline in the slice. That
 * is what makes two adjacent sections' `bytes` (a UTF-8 byte count) sum to the
 * UTF-8 bytes between them.
 *
 * @param content - The decoded document text
 * @returns One offset per line, in order
 */
function lineStartOffsets(content: string): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of content.split('\n')) {
    starts.push(offset);
    // + 1 for the newline `split` consumed.
    offset += line.length + 1;
  }
  return starts;
}

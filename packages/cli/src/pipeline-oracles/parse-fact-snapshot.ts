/**
 * Oracle 2 — the parse-fact snapshot.
 *
 * Facts a parse produces from one blob, keyed by content key rather than by
 * path. That is not a stylistic choice: it is what makes this snapshot double
 * as the parse cache's correctness oracle. If two paths key the same and their
 * facts differ, a content-addressed cache is unsound; if the same bytes key
 * differently across runs, it is useless. Both are visible here and neither is
 * visible in command output.
 */

import { createHash } from 'node:crypto';

import { parseHtml, parseMarkdown, readContentWithKey } from '@vibe-agent-toolkit/resources';
import type { HeadingNode, ParserKind, ParseResult, ResourceLink } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';

import { relativize } from './path-facts.js';
import type {
  ConditionFact,
  FrontmatterFieldFact,
  HeadingFact,
  KeyDisagreement,
  LinkFact,
  OptionalArrayState,
  ParseFactRow,
  ParseFactSnapshot,
} from './types.js';

/**
 * Every field of {@link ParseResult}, accounted for.
 *
 * ## Why this exists
 *
 * This snapshot is the correctness oracle for a content-addressed parse cache:
 * its whole claim is *"if a cached parse differs from a fresh one, a row here
 * differs."* A field of `ParseResult` that no row records breaks that claim
 * silently — the cache corrupts it, every golden stays green, and the gate
 * reports success for the one thing it was built to catch.
 *
 * That is not hypothetical. `anchors` was uncovered until 2026-08-07, and it is
 * the input to `ResourceRegistry.buildFragmentIndex` — i.e. to every
 * `file.md#fragment` check in VAT.
 *
 * ## How it is enforced
 *
 * Each field is listed in exactly one of the two unions below, and
 * {@link UnaccountedParseResultFields} is asserted empty at compile time. Adding
 * a field to `ParseResult` therefore fails `tsc` until someone states which
 * bucket it belongs in. This module is under `src/`, so it is genuinely
 * typechecked — a guard written in `test/` would assert nothing, because no test
 * file in this repository is typechecked.
 */
type CapturedParseResultField =
  | 'links'
  | 'headings'
  | 'frontmatter'
  | 'frontmatterError'
  | 'frontmatterSource'
  | 'sizeBytes'
  | 'estimatedTokenCount'
  | 'anchors'
  | 'parseErrors'
  | 'unresolvedReferences';

/**
 * Fields deliberately not recorded verbatim, each with the assertion that
 * stands in for it.
 *
 * - `content`: storing it would make the golden a copy of the corpus. The row
 *   carries `contentMatchesKey` instead, which asserts the parser handed back
 *   the bytes it was keyed on — the property a cache can actually violate.
 */
type UnrecordedParseResultField = 'content';

/** Non-empty iff `ParseResult` grew a field neither union mentions. */
type UnaccountedParseResultFields = Exclude<
  keyof ParseResult,
  CapturedParseResultField | UnrecordedParseResultField
>;

/**
 * Compile-time assertion that every `ParseResult` field is accounted for.
 *
 * When this line errors, the type of `PARSE_RESULT_FIELDS_ACCOUNTED_FOR` names
 * the unlisted field(s). Add each to `CapturedParseResultField` **and record it
 * in `toRow`**, or to `UnrecordedParseResultField` **with the assertion that
 * replaces it**. Do not widen the union to silence the error.
 */
export const PARSE_RESULT_FIELDS_ACCOUNTED_FOR: UnaccountedParseResultFields extends never ? true : never = true;

/**
 * Capture parse facts for a set of absolute paths.
 *
 * @param absolutePaths - Paths to parse; unreadable ones are skipped, not fatal
 * @param options - Corpus root (for relativizing) and label
 * @returns The snapshot, rows ordered by content key
 */
export async function captureParseFactSnapshot(
  absolutePaths: readonly string[],
  options: { corpusRoot: string; corpus: string },
): Promise<ParseFactSnapshot> {
  const corpusRoot = safePath.resolve(options.corpusRoot);
  const byKey = new Map<string, ParseFactRow>();
  const firstPathByKey = new Map<string, string>();
  const pathsByKey = new Map<string, string[]>();
  const keyDisagreements: KeyDisagreement[] = [];

  for (const absolutePath of absolutePaths) {
    const keyed = await readKeyedOrSkip(absolutePath);
    if (keyed === null) {
      continue;
    }

    const relativePath = relativize(absolutePath, corpusRoot);
    const paths = pathsByKey.get(keyed.key) ?? [];
    paths.push(relativePath);
    pathsByKey.set(keyed.key, paths);

    // ⛔ Every path is parsed, including the second and later arrivals under a
    // key already recorded. Skipping them would be the cache's assumption —
    // "same key implies same facts" — implemented inside the instrument that
    // exists to test it, leaving nothing to compare against.
    const parsed = await parseOrNull(absolutePath, keyed.parserKind);
    if (parsed === null) {
      continue;
    }
    const row = toRow(keyed.key, keyed.parserKind, parsed);

    const existing = byKey.get(keyed.key);
    if (existing === undefined) {
      byKey.set(keyed.key, row);
      firstPathByKey.set(keyed.key, relativePath);
      continue;
    }

    const fields = diffParseFactRows(existing, row);
    if (fields.length > 0) {
      keyDisagreements.push({
        contentKey: keyed.key,
        firstPath: firstPathByKey.get(keyed.key) ?? relativePath,
        otherPath: relativePath,
        fields,
      });
    }
  }

  return {
    corpus: options.corpus,
    rows: [...byKey.values()].sort((a, b) => a.contentKey.localeCompare(b.contentKey)),
    pathsByKey: Object.fromEntries(
      [...pathsByKey.entries()]
        .map(([key, paths]) => [key, [...paths].sort((a, b) => a.localeCompare(b))] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    keyDisagreements: keyDisagreements.toSorted(
      (a, b) => a.contentKey.localeCompare(b.contentKey) || a.otherPath.localeCompare(b.otherPath),
    ),
  };
}

/**
 * Name the {@link ParseFactRow} fields on which two independent parses of the
 * same content key disagree.
 *
 * Field-by-field rather than one digest over the whole row, because the answer
 * has to localize: "two paths under one key parse differently" is unactionable,
 * while "they differ on `links`" names the lane and the fix. Compared through a
 * structural rendering so array order counts — a reordering of `links` is a
 * disagreement, since ordinals are the addressable part.
 *
 * @param first - The row recorded for the key's first path
 * @param other - The row a later path under the same key produced
 * @returns Differing field names, sorted; empty when the rows agree
 */
export function diffParseFactRows(first: ParseFactRow, other: ParseFactRow): string[] {
  const fields = new Set([...Object.keys(first), ...Object.keys(other)]);
  const differing: string[] = [];
  for (const field of fields) {
    const a = (first as unknown as Record<string, unknown>)[field];
    const b = (other as unknown as Record<string, unknown>)[field];
    if (renderValue(a, new WeakSet()) !== renderValue(b, new WeakSet())) {
      differing.push(field);
    }
  }
  return differing.toSorted((a, b) => a.localeCompare(b));
}

/** Read+key a path, or report null when it cannot be read. */
async function readKeyedOrSkip(
  absolutePath: string,
): Promise<{ key: string; content: string; parserKind: ParserKind } | null> {
  try {
    return await readContentWithKey(absolutePath);
  } catch {
    return null;
  }
}

/** Parse via the same discriminator the registry uses. */
async function parseOrNull(absolutePath: string, parserKind: string): Promise<ParseResult | null> {
  try {
    return parserKind === 'html' ? await parseHtml(absolutePath) : await parseMarkdown(absolutePath);
  } catch {
    return null;
  }
}

/** Assemble one row from a parse result. */
function toRow(contentKey: string, parserKind: ParserKind, parsed: ParseResult): ParseFactRow {
  return {
    contentKey,
    parserKind,
    sizeBytes: parsed.sizeBytes,
    estimatedTokenCount: parsed.estimatedTokenCount,
    links: parsed.links.map(toLinkFact),
    headings: flattenHeadings(parsed.headings),
    // Read off the parse result, not re-derived from the bytes. This module
    // used to carry its own regex delimiter — a second implementation of
    // frontmatter delimiting, which existed only because `ParseResult` did not
    // expose the source. It does now, so the column records what the PARSER
    // said, which is the only thing a cache can actually get wrong.
    frontmatterSource: parsed.frontmatterSource ?? null,
    frontmatterFields: toFrontmatterFields(parsed.frontmatter),
    // Absent stays distinguishable from empty: both parsers omit the key rather
    // than emitting `[]`, so `null` and `[]` are different observations.
    anchors: parsed.anchors === undefined ? null : [...parsed.anchors],
    decodedLength: parsed.content.length,
    conditions: collectConditions(parsed),
    optionalArrays: [
      { field: 'anchors', state: arrayState(parsed.anchors) },
      { field: 'parseErrors', state: arrayState(parsed.parseErrors) },
      { field: 'unresolvedReferences', state: arrayState(parsed.unresolvedReferences) },
    ],
  };
}

/**
 * Classify how an optional array field was supplied.
 *
 * @param value - The field, possibly undefined
 * @returns Whether it was missing, present-and-empty, or populated
 */
function arrayState(value: readonly unknown[] | undefined): OptionalArrayState {
  if (value === undefined) {
    return 'absent';
  }
  return value.length === 0 ? 'empty' : 'present';
}

/**
 * Record top-level frontmatter keys and the runtime shape of their values.
 *
 * Shapes rather than values, and top level only. Both restrictions are load-
 * bearing: a cyclic YAML anchor makes any recursive value capture throw (so the
 * document would silently never be recorded), while `typeof`/constructor name
 * is precisely what a lossy round-trip changes — `Infinity` → `null`,
 * `Buffer` → `Object`, `Date` → `String`.
 *
 * @param frontmatter - The parsed frontmatter object, or undefined when absent
 * @returns One fact per key, sorted by key, or null when frontmatter is absent
 */
function toFrontmatterFields(frontmatter: Record<string, unknown> | undefined): FrontmatterFieldFact[] | null {
  if (frontmatter === undefined) {
    return null;
  }
  return Object.entries(frontmatter)
    .map(([key, value]) => ({ key, typeName: typeNameOf(value), valueDigest: digestValue(value) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * A short, stable digest of a frontmatter value.
 *
 * Hand-rolled rather than `JSON.stringify` because every input this exists to
 * survive breaks that: `.inf`/`.nan` serialize to `null`, `!!binary` becomes a
 * Buffer envelope, `Date` becomes a string, and a cyclic YAML anchor throws —
 * which would mean the document is silently never recorded at all.
 *
 * @param value - Any frontmatter value
 * @returns 12 hex characters of a SHA-256 over a structural rendering
 */
function digestValue(value: unknown): string {
  return createHash('sha256').update(renderValue(value, new WeakSet())).digest('hex').slice(0, 12);
}

/**
 * Render a value structurally, tagging each node with its shape.
 *
 * Types are part of the rendering, so `1` and `'1'` do not collide, and keys are
 * sorted so an object's digest does not depend on insertion order.
 *
 * @param value - The value to render
 * @param seen - Objects already on the current path, for cycle detection
 * @returns A deterministic string
 */
function renderValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null || typeof value !== 'object') {
    return `${typeNameOf(value)}:${String(value)}`;
  }
  if (seen.has(value)) {
    // A cyclic anchor. Recorded as a marker rather than followed: the fact that
    // a cycle is here is the durable observation, and following it does not
    // terminate.
    return '<cycle>';
  }
  seen.add(value);
  const rendered = Array.isArray(value)
    ? `[${value.map((item) => renderValue(item, seen)).join(',')}]`
    : `{${Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${key}=${renderValue(item, seen)}`)
        .join(',')}}`;
  seen.delete(value);
  return `${typeNameOf(value)}${rendered}`;
}

/**
 * Name a value's runtime shape without reading the value itself.
 *
 * @param value - Any frontmatter value
 * @returns `'null'`, a `typeof` result, or the constructor name for objects
 */
function typeNameOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return typeof value;
  }
  // Array/Date/Buffer/Object are all distinct answers here, and a lossy
  // round-trip moves a value between them.
  return (value.constructor as { name?: string } | undefined)?.name ?? 'Object';
}

/**
 * One link occurrence with its ordinal.
 *
 * The ordinal is the addressable part. `href` alone is not an identity — a
 * document may link the same target ten times, and "link 7 moved" is a
 * different finding from "a link changed target".
 */
function toLinkFact(link: ResourceLink, index: number): LinkFact {
  return {
    ordinal: index,
    href: link.href,
    text: link.text,
    type: link.type,
    line: link.line ?? null,
    nodeType: link.nodeType ?? null,
    resolvedId: link.resolvedId ?? null,
  };
}

/**
 * Flatten the heading tree into document order with ordinals.
 *
 * `HeadingNode` nests children, which is the right shape for a table of
 * contents and the wrong shape for diffing: a heading moving one level changes
 * the whole subtree's position in the nested rendering. Flat + explicit level
 * makes the diff say what actually changed.
 */
function flattenHeadings(headings: readonly HeadingNode[]): HeadingFact[] {
  const flat: HeadingFact[] = [];
  const walk = (nodes: readonly HeadingNode[]): void => {
    for (const node of nodes) {
      flat.push({
        ordinal: flat.length,
        level: node.level,
        text: node.text,
        slug: node.slug,
        line: node.line ?? null,
      });
      if (node.children !== undefined) {
        walk(node.children);
      }
    }
  };
  walk(headings);
  return flat;
}

/**
 * Parse-time oddities, as rows over an open vocabulary.
 *
 * Adding a new kind of oddity is adding rows, never changing this shape — which
 * is the same reason the projection schema is rows rather than columns.
 */
function collectConditions(parsed: ParseResult): ConditionFact[] {
  const conditions: ConditionFact[] = [];

  if (parsed.frontmatterError !== undefined) {
    conditions.push({ code: 'FRONTMATTER_INVALID_YAML', message: parsed.frontmatterError, line: 1 });
  }
  for (const error of parsed.parseErrors ?? []) {
    conditions.push({
      code: 'MALFORMED_HTML',
      message: error.message,
      line: error.line ?? null,
    });
  }
  for (const reference of parsed.unresolvedReferences ?? []) {
    conditions.push({
      code: 'LINK_UNRESOLVED_REFERENCE',
      message: reference.label,
      line: reference.line,
    });
  }

  return conditions.sort(
    (a, b) => a.code.localeCompare(b.code) || (a.line ?? 0) - (b.line ?? 0) || a.message.localeCompare(b.message),
  );
}

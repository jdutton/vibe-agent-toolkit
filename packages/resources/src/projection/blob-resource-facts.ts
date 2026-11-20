/**
 * Where every fact `vat validate` reads about a resource comes from, and the ONE
 * reader that rebuilds the content-addressed half of a `ResourceMetadata` from a
 * blob's stored facts.
 *
 * ## The mapping table
 *
 * Every `ResourceMetadata` field, and every registry output validate reads, maps
 * to exactly one source:
 *
 * - `blob-fact` — a pure function of the bytes, held per content key in the blob
 *   tier (`blobs`, `blob_references`, `blob_sections`, `blob_conditions`) and
 *   rebuilt by {@link blobFactsReader};
 * - `live` — recomputed every run by the same code as the cold lane, because it
 *   depends on a path, a config or the rest of the population (an id, a
 *   collection, a link's resolution);
 * - `per-file-read` — read from the file this run, and counted (`fs.stat`,
 *   `content.read`): a stat, or an outcome that describes this run rather than
 *   the bytes.
 *
 * There is no cold-only category: a fact warm validate needs that the store lacks
 * becomes a blob fact (an extractor fact), never an exception list.
 *
 * {@link RESOURCE_METADATA_FACT_SOURCES} is checked against `ResourceMetadata`'s
 * keys by the type system: a field added to `ResourceMetadataSchema` and not
 * mapped here, or mapped here and gone from the schema, stops this module
 * compiling.
 *
 * ## The reader is the only reader
 *
 * A warm lane that rebuilds a resource from the store does so through
 * {@link blobFactsReader} and nothing else, so the round-trip test that holds
 * this reader against the cold registry holds every such lane against it.
 *
 * ## What the reader refuses
 *
 * The rows are checked against the counts the `blobs` row carries (`linkCount`,
 * `headingCount`) and against what a parse can produce (an AST link has text, an
 * unresolved reference has a line). A mismatch is `uncovered`, never a guess: a
 * warm run derives the blob again rather than validate a partial resource.
 */

import { decodeFrontmatterValue } from '../frontmatter-codec.js';
import { classifyLink } from '../link-classify.js';
import { toHeadingTree } from '../link-parser.js';
import type { BlobConditionRow, BlobReferenceRow, BlobRow, BlobSectionRow, ReferenceSyntacticForm } from '../schemas/projection-blobs.js';
import type { HtmlParseError, LinkNodeType, ResourceLink, ResourceMetadata, UnresolvedReference } from '../schemas/resource-metadata.js';

import { BLOB_NOT_TEXT, parserKindOf } from './blob-population.js';
import { blobConditionEntry, type NotAdmittedEntry } from './blob-refusals.js';
import { NOT_TEXT_RESOURCE_FACTS } from './document-facts.js';
import type { BlobScopedRows } from './store.js';

/** A pure function of the bytes, held per content key in the blob tier. */
const BLOB_FACT = 'blob-fact';
/** Recomputed every run by the cold lane's own code. */
const LIVE = 'live';
/** Read from the file this run, and counted. */
const PER_FILE_READ = 'per-file-read';

/** Where one fact comes from on a warm run. See this module's header. */
export type FactSource = typeof BLOB_FACT | typeof LIVE | typeof PER_FILE_READ;

/**
 * Every `ResourceMetadata` field, and where a warm run gets it.
 *
 * `satisfies` over `keyof ResourceMetadata` with `-?`: a field missing here is a
 * compile error, and so is a key the schema does not have.
 */
export const RESOURCE_METADATA_FACT_SOURCES = {
  // `generateId`: the frontmatter id field, else the path relative to the view's base.
  id: LIVE,
  // Where the population found the bytes.
  filePath: LIVE,
  // Shape from `blob_references`; each link's resolution is live (see RESOURCE_LINK_FACT_SOURCES).
  links: BLOB_FACT,
  headings: BLOB_FACT,
  anchors: BLOB_FACT,
  parseErrors: BLOB_FACT,
  unresolvedReferences: BLOB_FACT,
  frontmatter: BLOB_FACT,
  frontmatterError: BLOB_FACT,
  // `stat().size`, the one stat that also serves `modifiedAt`.
  sizeBytes: PER_FILE_READ,
  estimatedTokenCount: BLOB_FACT,
  modifiedAt: PER_FILE_READ,
  // A hash of the decoded content: its fate (the content key, or a stored fact) is decided where
  // warm validate starts reading blob facts. Until then it is the read it always was.
  checksum: PER_FILE_READ,
  // The config's collection patterns, matched against the path.
  collections: LIVE,
} as const satisfies { readonly [Field in keyof ResourceMetadata]-?: FactSource };

/**
 * Every `ResourceLink` field, and where a warm run gets it: the shape is a blob
 * fact, its resolution against a population is live.
 */
export const RESOURCE_LINK_FACT_SOURCES = {
  text: BLOB_FACT,
  href: BLOB_FACT,
  type: BLOB_FACT,
  line: BLOB_FACT,
  startOffset: BLOB_FACT,
  endOffset: BLOB_FACT,
  nodeType: BLOB_FACT,
  resolvedPath: LIVE,
  anchorTarget: LIVE,
  resolvedId: LIVE,
} as const satisfies { readonly [Field in keyof ResourceLink]-?: FactSource };

/** Every registry output `vat validate` reads besides the resources themselves. */
export type RegistryOutput =
  | 'populationConditions'
  | 'parseRefusals'
  | 'unresolvedReferences'
  | 'duplicateIdCollisions'
  | 'notAdmittedUnreadable'
  | 'notAdmittedParseFailed';

/**
 * Every registry output, and where a warm run gets it.
 *
 * - population conditions: the population's own rows, recomputed per view;
 * - parse refusals (a limit, a dead worker): describe this run, never stored (ADR I6);
 * - unresolved references: `blob_conditions` `UNRESOLVED_REFERENCE`, via `ResourceMetadata`;
 * - duplicate id collisions: first-wins over the view's admission order, live;
 * - unreadable: this run's read failed;
 * - parse failed: `blob_conditions` `BLOB_PARSE_FAILED`, a fact of the bytes.
 */
export const REGISTRY_OUTPUT_FACT_SOURCES = {
  populationConditions: LIVE,
  parseRefusals: PER_FILE_READ,
  unresolvedReferences: BLOB_FACT,
  duplicateIdCollisions: LIVE,
  notAdmittedUnreadable: PER_FILE_READ,
  notAdmittedParseFailed: BLOB_FACT,
} as const satisfies { readonly [Output in RegistryOutput]-?: FactSource };

type MetadataSources = typeof RESOURCE_METADATA_FACT_SOURCES;

/** The `ResourceMetadata` fields the blob tier holds. */
export type BlobFactField = {
  [Field in keyof MetadataSources]: MetadataSources[Field] extends typeof BLOB_FACT ? Field : never;
}[keyof MetadataSources];

/** The fields of a `ResourceMetadata` the blob tier holds, read off the table. */
export const BLOB_FACT_FIELDS: readonly BlobFactField[] = (Object.keys(RESOURCE_METADATA_FACT_SOURCES) as (keyof MetadataSources)[])
  .filter((field): field is BlobFactField => RESOURCE_METADATA_FACT_SOURCES[field] === BLOB_FACT);

/** The `ResourceLink` fields the blob tier holds. */
export type BlobLinkField = {
  [Field in keyof typeof RESOURCE_LINK_FACT_SOURCES]: (typeof RESOURCE_LINK_FACT_SOURCES)[Field] extends typeof BLOB_FACT ? Field : never;
}[keyof typeof RESOURCE_LINK_FACT_SOURCES];

/** A link as the blob tier holds it: its shape, never its resolution. */
export type BlobLink = Pick<ResourceLink, BlobLinkField>;

/** The content-addressed half of a `ResourceMetadata`. */
export type BlobResourceFacts = Omit<Pick<ResourceMetadata, BlobFactField>, 'links'> & { links: BlobLink[] };

/** What the blob tier says about one content key. */
export type BlobFactsOutcome =
  /** The resource's blob facts. */
  | { readonly kind: 'facts'; readonly facts: BlobResourceFacts }
  /** Every realization of the key is refused, as the registry lane refuses it. */
  | { readonly kind: 'not-admitted'; readonly entry: NotAdmittedEntry }
  /** The tier holds nothing usable for the key: a warm run derives it again. */
  | { readonly kind: 'uncovered'; readonly reason: string };

/** One key's rows, gathered in one pass over the bundle. */
interface KeyRows {
  blob: BlobRow | undefined;
  references: BlobReferenceRow[];
  sections: BlobSectionRow[];
  conditions: BlobConditionRow[];
}

/** A rebuild step's answer: the value, or why the rows cannot be trusted. */
type Rebuilt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/**
 * The ONE reader of the blob tier's resource facts.
 *
 * @param rows - Blob-scoped rows for any set of keys, as a store returns them
 * @returns A reader for one key at a time; the bundle is indexed once
 */
export function blobFactsReader(rows: BlobScopedRows): (contentKey: string) => BlobFactsOutcome {
  const byKey = indexByKey(rows);
  return (contentKey) => outcomeOf(contentKey, byKey.get(contentKey));
}

/**
 * @param rows - The bundle
 * @returns Each key's rows
 */
function indexByKey(rows: BlobScopedRows): Map<string, KeyRows> {
  const byKey = new Map<string, KeyRows>();
  const of = (key: string): KeyRows => {
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { blob: undefined, references: [], sections: [], conditions: [] };
      byKey.set(key, entry);
    }
    return entry;
  };
  for (const row of rows.blobs) of(row.contentKey).blob = row;
  for (const row of rows.blobReferences) of(row.blob).references.push(row);
  for (const row of rows.blobSections) of(row.blob).sections.push(row);
  for (const row of rows.blobConditions) of(row.blob).conditions.push(row);
  return byKey;
}

/**
 * @param contentKey - The key asked about
 * @param rows - Its rows, if the bundle held any
 * @returns What the tier says about it
 */
function outcomeOf(contentKey: string, rows: KeyRows | undefined): BlobFactsOutcome {
  if (rows === undefined) return { kind: 'uncovered', reason: `the blob tier holds no rows for ${contentKey}` };
  if (rows.blob !== undefined) {
    const facts = factsOf(rows.blob, rows);
    return facts.ok ? { kind: 'facts', facts: facts.value } : { kind: 'uncovered', reason: `${contentKey}: ${facts.reason}` };
  }
  // Not text: one rule for both lanes (`document-facts.ts`), so the facts are the constant.
  if (rows.conditions.some((row) => row.code === BLOB_NOT_TEXT)) {
    return { kind: 'facts', facts: { ...NOT_TEXT_RESOURCE_FACTS, links: [], headings: [] } };
  }
  for (const row of rows.conditions) {
    const entry = blobConditionEntry(row);
    if (entry !== undefined) return { kind: 'not-admitted', entry };
  }
  return { kind: 'uncovered', reason: `the blob tier holds no blobs row for ${contentKey}` };
}

/**
 * @param left - A row with an ordinal
 * @param right - Another
 * @returns Their order by ordinal
 */
function byOrdinal(left: { readonly ordinal: number }, right: { readonly ordinal: number }): number {
  return left.ordinal - right.ordinal;
}

/**
 * The finding conditions of one code, in the order the parse emitted them.
 *
 * @param rows - Every row the key holds
 * @param code - The finding code
 * @returns Its rows by ordinal
 */
function findings(rows: KeyRows, code: string): BlobConditionRow[] {
  return rows.conditions.filter((row) => row.code === code).sort(byOrdinal);
}

/**
 * @param rows - Every row the key holds
 * @returns The unresolved references, or why the rows cannot be one (a reference always has a line)
 */
function unresolvedOf(rows: KeyRows): Rebuilt<UnresolvedReference[]> {
  const unresolved: UnresolvedReference[] = [];
  for (const row of findings(rows, 'UNRESOLVED_REFERENCE')) {
    if (row.line === null) return { ok: false, reason: 'an UNRESOLVED_REFERENCE row has no line' };
    unresolved.push({ label: row.message, line: row.line });
  }
  return { ok: true, value: unresolved };
}

/**
 * @param blob - The key's `blobs` row
 * @param rows - Every row the key holds
 * @returns The resource facts, or why the rows cannot be trusted
 */
function factsOf(blob: BlobRow, rows: KeyRows): Rebuilt<BlobResourceFacts> {
  const links = linksOf(rows.references);
  if (!links.ok) return links;
  if (links.value.length !== blob.linkCount) {
    return { ok: false, reason: `${String(links.value.length)} AST reference rows against linkCount ${String(blob.linkCount)}` };
  }
  if (rows.sections.length !== blob.headingCount) {
    return { ok: false, reason: `${String(rows.sections.length)} section rows against headingCount ${String(blob.headingCount)}` };
  }
  const unresolved = unresolvedOf(rows);
  if (!unresolved.ok) return unresolved;
  const parseErrors: HtmlParseError[] = findings(rows, 'HTML_PARSE_ERROR')
    .map((row) => ({ message: row.message, ...(row.line !== null && { line: row.line }) }));
  return {
    ok: true,
    value: {
      links: links.value,
      headings: headingsOf(rows.sections),
      ...(blob.anchors.length > 0 && { anchors: blob.anchors }),
      ...(parseErrors.length > 0 && { parseErrors }),
      // Present for every markdown parse, empty or not; no other parser produces the field.
      ...(parserKindOf(blob.contentKey) === 'markdown' && { unresolvedReferences: unresolved.value }),
      ...(blob.frontmatterValue !== null && { frontmatter: decodeFrontmatterValue(blob.frontmatterValue) }),
      ...(blob.frontmatterError !== null && { frontmatterError: blob.frontmatterError }),
      estimatedTokenCount: blob.tokenEstimate,
    },
  };
}

/** The node type each AST-derived syntactic form was produced from; a lexer form has none. */
const NODE_TYPE_OF_FORM: Readonly<Partial<Record<ReferenceSyntacticForm, LinkNodeType>>> = {
  'markdown-link': 'link',
  'markdown-link-reference': 'linkReference',
  'markdown-definition': 'definition',
  'html-link': 'htmlAttribute',
};

/**
 * The parser's links, in the parser's order (`astIndex`), never source order.
 *
 * @param references - The key's reference rows
 * @returns The links, or why the rows cannot be links
 */
function linksOf(references: readonly BlobReferenceRow[]): Rebuilt<BlobLink[]> {
  const ast = references.flatMap((row) => {
    const nodeType = NODE_TYPE_OF_FORM[row.syntacticForm];
    return nodeType === undefined ? [] : [{ row, nodeType }];
  });
  ast.sort((left, right) => (left.row.astIndex ?? -1) - (right.row.astIndex ?? -1));
  const links: BlobLink[] = [];
  for (const { row, nodeType } of ast) {
    if (row.text === null || row.astIndex === null) return { ok: false, reason: `AST reference row ${String(row.ordinal)} has no text or no astIndex` };
    links.push({
      text: row.text,
      href: row.rawRef,
      type: classifyLink(row.rawRef),
      ...(row.line !== null && { line: row.line }),
      ...(row.startOffset !== null && { startOffset: row.startOffset }),
      ...(row.endOffset !== null && { endOffset: row.endOffset }),
      nodeType,
    });
  }
  return { ok: true, value: links };
}

/**
 * The heading tree, slugged by replaying the one stateful slugger over the titles in
 * document order - exactly as the parse slugged them - and nested the parse's way.
 *
 * @param sections - The key's section rows
 * @returns The heading tree
 */
function headingsOf(sections: readonly BlobSectionRow[]): ResourceMetadata['headings'] {
  return toHeadingTree([...sections].sort(byOrdinal).map((row) => ({
    level: row.depth,
    text: row.title,
    ...(row.lineStart !== null && { line: row.lineStart }),
  })));
}

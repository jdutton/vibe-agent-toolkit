/**
 * Where every fact `vat validate` reads about a resource comes from, and the ONE
 * reader that rebuilds the content-addressed half of a `ResourceMetadata` from a
 * blob's stored facts.
 *
 * ## The mapping table
 *
 * Every `ResourceMetadata` field, and every `ResourceLink` field, maps to exactly
 * one source:
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
 * {@link RESOURCE_METADATA_FACT_SOURCES} and {@link RESOURCE_LINK_FACT_SOURCES} are
 * checked against `ResourceMetadata`'s and `ResourceLink`'s keys by the type
 * system: a field added to either schema and not mapped here, or mapped here and
 * gone from the schema, stops this module compiling. The registry's other outputs
 * (its not-admitted and refusal logs, collisions, conditions) are not mapped
 * here: no type enumerates them, so a table of them would be a hand-kept list.
 *
 * ## The reader is the only reader
 *
 * A warm lane that rebuilds a resource from the store does so through
 * {@link blobFactsReader} and nothing else, so the round-trip test that holds
 * this reader against the cold registry holds every such lane against it. Warm
 * `vat validate` is one: on a store hit its resources registry admits each
 * member from these facts (`stored-admission.ts`), and a cold admission builds
 * the same facts from its parse through {@link blobResourceFactsOf}, so both are
 * turned into a `ResourceMetadata` by one code path.
 *
 * ## What the reader refuses
 *
 * The rows are checked against the counts the `blobs` row carries (`linkCount`,
 * `headingCount`, `findingCount`), their numbering is checked for gaps and repeats
 * (`astIndex`, each table's `ordinal`), and they are checked against what a parse
 * can produce (an AST link has text, an unresolved reference has a line, the
 * frontmatter decodes). A mismatch is `uncovered`, never a guess or a throw: a
 * warm run derives the blob again rather than validate a partial resource.
 */

import { isVatError } from '@vibe-agent-toolkit/utils';

import { decodeFrontmatterValue, FRONTMATTER_VALUE_MALFORMED } from '../frontmatter-codec.js';
import { toHeadingTree } from '../heading-tree.js';
import { classifyLink } from '../link-classify.js';
import type { ParseResult } from '../link-parser.js';
import type { FlatHeading } from '../parse-capabilities.js';
import type { BlobConditionRow, BlobReferenceRow, BlobRow, BlobSectionRow } from '../schemas/projection-blobs.js';
import type { HtmlParseError, ResourceLink, ResourceMetadata, UnresolvedReference } from '../schemas/resource-metadata.js';

import { BLOB_FINDING_CONDITION_CODES } from './blob-facts.js';
import { BLOB_NOT_TEXT, parserKindOf } from './blob-population.js';
import { NODE_TYPE_OF_AST_FORM } from './blob-references.js';
import { notAdmittedEntriesByBlob, type NotAdmittedEntry } from './blob-refusals.js';
import { NOT_TEXT_RESOURCE_FACTS } from './document-facts.js';
import type { BlobScopedRows } from './store.js';

/** A pure function of the bytes, held per content key in the blob tier. */
const BLOB_FACT = 'blob-fact';
/** Recomputed every run by the cold lane's own code. */
const LIVE = 'live';
/** Read from the file this run, and counted. */
const PER_FILE_READ = 'per-file-read';

/** Where one fact comes from on a warm run. See this module's header. */
type FactSource = typeof BLOB_FACT | typeof LIVE | typeof PER_FILE_READ;

/**
 * Every `ResourceMetadata` field, and where a warm run gets it.
 *
 * `satisfies` over `keyof ResourceMetadata` with `-?`: a field missing here is a
 * compile error, and so is a key the schema does not have.
 */
const RESOURCE_METADATA_FACT_SOURCES = {
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
  // The blob tier's own key: the rows are filed under it.
  contentKey: BLOB_FACT,
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

type MetadataSources = typeof RESOURCE_METADATA_FACT_SOURCES;

/** The `ResourceMetadata` fields the blob tier holds. */
type BlobFactField = {
  [Field in keyof MetadataSources]: MetadataSources[Field] extends typeof BLOB_FACT ? Field : never;
}[keyof MetadataSources];

/** The fields of a `ResourceMetadata` the blob tier holds, read off the table. */
export const BLOB_FACT_FIELDS: readonly BlobFactField[] = (Object.keys(RESOURCE_METADATA_FACT_SOURCES) as (keyof MetadataSources)[])
  .filter((field): field is BlobFactField => RESOURCE_METADATA_FACT_SOURCES[field] === BLOB_FACT);

/** The `ResourceLink` fields the blob tier holds. */
type BlobLinkField = {
  [Field in keyof typeof RESOURCE_LINK_FACT_SOURCES]: (typeof RESOURCE_LINK_FACT_SOURCES)[Field] extends typeof BLOB_FACT ? Field : never;
}[keyof typeof RESOURCE_LINK_FACT_SOURCES];

/** A link as the blob tier holds it: its shape, never its resolution. */
type BlobLink = Pick<ResourceLink, BlobLinkField>;

/**
 * One reader per field of `Target`, each reading it off a stored `Row`. Total
 * over `Target`'s keys (`-?`), and an optional field's reader may return
 * `undefined` (the field is then left out) while a required one's may not — so a
 * field added to the parser's output shape is a compile error here until the
 * reader says where it comes from.
 */
type FieldReaders<Target, Row> = { readonly [Field in keyof Target]-?: (row: Row) => Target[Field] };

/**
 * Build one object from its field readers, in the table's key order (the order
 * the parser writes them), leaving out a field whose reader returned
 * `undefined`.
 *
 * @param readers - One reader per field of `Target`
 * @param row - The stored row the fields are read from
 * @returns The rebuilt object
 */
function buildFrom<Target, Row>(readers: FieldReaders<Target, Row>, row: Row): Target {
  const built: Record<string, unknown> = {};
  for (const [field, read] of Object.entries(readers) as [string, (from: Row) => unknown][]) {
    const value = read(row);
    if (value !== undefined) built[field] = value;
  }
  return built as Target;
}

/** A finding row whose line the caller has already required. */
type LinedConditionRow = BlobConditionRow & { line: number };

/** `UnresolvedReference`, from an `UNRESOLVED_REFERENCE` condition row. */
const UNRESOLVED_REFERENCE_FIELDS: FieldReaders<UnresolvedReference, LinedConditionRow> = {
  label: (row) => row.message,
  line: (row) => row.line,
};

/** `HtmlParseError`, from an `HTML_PARSE_ERROR` condition row. */
const HTML_PARSE_ERROR_FIELDS: FieldReaders<HtmlParseError, BlobConditionRow> = {
  message: (row) => row.message,
  line: (row) => row.line ?? undefined,
};

/**
 * `FlatHeading`, from a `blob_sections` row. The `HeadingNode` tree is built
 * from these by `toHeadingTree`, the same code the parser runs, so its fields
 * need no table of their own.
 */
const FLAT_HEADING_FIELDS: FieldReaders<FlatHeading, BlobSectionRow> = {
  level: (row) => row.depth,
  text: (row) => row.title,
  line: (row) => row.lineStart ?? undefined,
};

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

/**
 * The content-addressed half of a resource, from a cold parse: the ONE
 * projection a cold admission builds its facts through, so a cold resource and
 * one rebuilt from the store by {@link blobFactsReader} are built into a
 * `ResourceMetadata` by the same code (`ResourceRegistry`'s `readAndKey`).
 *
 * Shares the parse's objects rather than copying them: a registry view copies
 * what it mutates (its links and headings).
 *
 * @param parse - The parse of the bytes (or the not-text constant facts)
 * @param contentKey - The key of the bytes parsed
 * @returns The resource's blob facts
 */
export function blobResourceFactsOf(parse: ParseResult, contentKey: string): BlobResourceFacts {
  return {
    links: parse.links,
    headings: parse.headings,
    ...optionalParseFacts(parse),
    estimatedTokenCount: parse.estimatedTokenCount,
    contentKey,
  };
}

/** The parse facts a resource carries only when its parse produced them. */
type OptionalParseFacts = Pick<BlobResourceFacts, 'anchors' | 'parseErrors' | 'unresolvedReferences' | 'frontmatter' | 'frontmatterError'>;

/**
 * The optional parse facts, each present exactly when the source holds it, in
 * the one order a resource carries them: what {@link blobResourceFactsOf} takes
 * from a parse and what a registry takes from either builder's facts.
 *
 * @param source - A parse, or a resource's blob facts
 * @returns The optional facts it holds
 */
export function optionalParseFacts(source: OptionalParseFacts): OptionalParseFacts {
  return {
    ...(source.anchors !== undefined && { anchors: source.anchors }),
    ...(source.parseErrors !== undefined && { parseErrors: source.parseErrors }),
    ...(source.unresolvedReferences !== undefined && { unresolvedReferences: source.unresolvedReferences }),
    ...(source.frontmatter !== undefined && { frontmatter: source.frontmatter }),
    ...(source.frontmatterError !== undefined && { frontmatterError: source.frontmatterError }),
  };
}

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
 * What the tier says about one key without building its facts: the kind
 * {@link BlobFactsReader.outcome} returns for it, and how many of the key's rows
 * were read to say so.
 */
interface BlobTierAnswer {
  readonly kind: BlobFactsOutcome['kind'];
  /** The key's rows: its `blobs` row and every reference, section and condition row. */
  readonly rowsRead: number;
}

/** The ONE reader of the blob tier's resource facts, over one indexed bundle. */
export interface BlobFactsReader {
  /** The key's facts, rebuilt on every ask and never retained by the reader: its caller owns them. */
  readonly outcome: (contentKey: string) => BlobFactsOutcome;
  /**
   * The kind {@link outcome} returns, decided by the same checks of the same rows
   * without building the facts. A stored frontmatter value is decoded and
   * dropped: whether it decodes is decided only by decoding it.
   */
  readonly answer: (contentKey: string) => BlobTierAnswer;
}

/**
 * The ONE reader of the blob tier's resource facts.
 *
 * @param rows - Blob-scoped rows for any set of keys, as a store returns them
 * @returns The reader; the bundle is indexed once, and nothing decoded is kept
 */
export function blobFactsReader(rows: BlobScopedRows): BlobFactsReader {
  const byKey = indexByKey(rows);
  return {
    outcome: (contentKey) => outcomeOf(contentKey, byKey.get(contentKey)),
    answer: (contentKey) => answerOf(contentKey, byKey.get(contentKey)),
  };
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

/** What a key's rows are, before any fact is built: the one classification both of the reader's answers make. */
type KeyVerdict =
  /** A `blobs` row: facts, once {@link blobRowsFault} finds nothing wrong with the rows. */
  | { readonly kind: 'blob'; readonly blob: BlobRow; readonly rows: KeyRows }
  /** Not text: the constant facts. */
  | { readonly kind: 'not-text' }
  | Extract<BlobFactsOutcome, { kind: 'not-admitted' | 'uncovered' }>;

/**
 * @param contentKey - The key asked about
 * @param rows - Its rows, if the bundle held any
 * @returns What its rows are
 */
function verdictOf(contentKey: string, rows: KeyRows | undefined): KeyVerdict {
  if (rows === undefined) return { kind: 'uncovered', reason: `the blob tier holds no rows for ${contentKey}` };
  if (rows.blob !== undefined) return { kind: 'blob', blob: rows.blob, rows };
  // Not text: one rule for both lanes (`document-facts.ts`), so the facts are the constant.
  if (rows.conditions.some((row) => row.code === BLOB_NOT_TEXT)) return { kind: 'not-text' };
  const entry = notAdmittedEntriesByBlob(rows.conditions).get(contentKey);
  if (entry !== undefined) return { kind: 'not-admitted', entry };
  return { kind: 'uncovered', reason: `the blob tier holds no blobs row for ${contentKey}` };
}

/**
 * @param contentKey - The key asked about
 * @param rows - Its rows, if the bundle held any
 * @returns What the tier says about it
 */
function outcomeOf(contentKey: string, rows: KeyRows | undefined): BlobFactsOutcome {
  const verdict = verdictOf(contentKey, rows);
  if (verdict.kind === 'not-text') return { kind: 'facts', facts: { ...NOT_TEXT_RESOURCE_FACTS, links: [], headings: [], contentKey } };
  if (verdict.kind !== 'blob') return verdict;
  const facts = factsOf(verdict.blob, verdict.rows);
  return facts.ok ? { kind: 'facts', facts: facts.value } : { kind: 'uncovered', reason: `${contentKey}: ${facts.reason}` };
}

/**
 * @param contentKey - The key asked about
 * @param rows - Its rows, if the bundle held any
 * @returns The kind {@link outcomeOf} returns for it, and the rows read to say so
 */
function answerOf(contentKey: string, rows: KeyRows | undefined): BlobTierAnswer {
  const rowCountOf = (held: KeyRows): number =>
    (held.blob === undefined ? 0 : 1) + held.references.length + held.sections.length + held.conditions.length;
  const rowsRead = rows === undefined ? 0 : rowCountOf(rows);
  const verdict = verdictOf(contentKey, rows);
  if (verdict.kind === 'not-text') return { kind: 'facts', rowsRead };
  if (verdict.kind !== 'blob') return { kind: verdict.kind, rowsRead };
  return { kind: blobRowsFault(verdict.blob, verdict.rows) === undefined ? 'facts' : 'uncovered', rowsRead };
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
 * @param rows - Every row the key holds, already found sound by {@link rowsFault}
 * @returns The unresolved references
 */
function unresolvedOf(rows: KeyRows): UnresolvedReference[] {
  // `rowsFault` refused a row without a line, so none is skipped here.
  return findings(rows, 'UNRESOLVED_REFERENCE').flatMap((row) =>
    row.line === null ? [] : [buildFrom(UNRESOLVED_REFERENCE_FIELDS, { ...row, line: row.line })]);
}

/**
 * Whether rows numbered from 0 are numbered exactly 0..n-1: no gap, no repeat.
 *
 * @param numbers - Each row's number
 * @returns Whether the sorted numbers are their own indexes
 */
function isDense(numbers: readonly number[]): boolean {
  return [...numbers].sort((left, right) => left - right).every((value, index) => value === index);
}

/**
 * The finding rows checked against the `blobs` row: as many as it counted, each
 * code numbered 0..n-1.
 *
 * @param blob - The key's `blobs` row
 * @param rows - Every row the key holds
 * @returns Why the finding rows cannot be trusted, or `undefined`
 */
function findingRowsFault(blob: BlobRow, rows: KeyRows): string | undefined {
  let total = 0;
  for (const code of BLOB_FINDING_CONDITION_CODES) {
    const ordinals = rows.conditions.filter((row) => row.code === code).map((row) => row.ordinal);
    if (!isDense(ordinals)) return `the ${code} rows' ordinals have a gap or a repeat`;
    total += ordinals.length;
  }
  return total === blob.findingCount ? undefined : `${String(total)} finding rows against findingCount ${String(blob.findingCount)}`;
}

/**
 * The stored frontmatter, decoded, or why it cannot be. Only the codec's own
 * refusal is a fact about the rows; anything else it throws is a defect and propagates.
 *
 * @param blob - The key's `blobs` row
 * @returns The frontmatter, `undefined` when the blob has none, or the reason
 */
function frontmatterOf(blob: BlobRow): Rebuilt<Record<string, unknown> | undefined> {
  if (blob.frontmatterValue === null) return { ok: true, value: undefined };
  try {
    return { ok: true, value: decodeFrontmatterValue(blob.frontmatterValue) };
  } catch (error) {
    if (!isVatError(error, FRONTMATTER_VALUE_MALFORMED)) throw error;
    return { ok: false, reason: `frontmatterValue does not decode: ${error.message}` };
  }
}

/** An AST reference row and the link node type its syntactic form names. */
interface AstReference {
  readonly row: BlobReferenceRow;
  readonly nodeType: BlobLink['nodeType'];
}

/**
 * @param references - The key's reference rows
 * @returns The rows that are AST links (a raw-source reference is not), in stored order
 */
function astReferences(references: readonly BlobReferenceRow[]): AstReference[] {
  return references.flatMap((row) => {
    const nodeType = NODE_TYPE_OF_AST_FORM.get(row.syntacticForm);
    return nodeType === undefined ? [] : [{ row, nodeType }];
  });
}

/**
 * Every check of a key's rows that needs no decode, in the order a rebuild meets
 * them: each AST link row has text and an `astIndex`, numbered 0..n-1; the rows
 * add up to the `blobs` row's counts; every unresolved reference has a line.
 *
 * @param blob - The key's `blobs` row
 * @param rows - Every row the key holds
 * @param ast - The key's AST reference rows
 * @returns Why the rows cannot be trusted, or `undefined`
 */
function rowsFault(blob: BlobRow, rows: KeyRows, ast: readonly AstReference[]): string | undefined {
  const unindexed = ast.find(({ row }) => row.text === null || row.astIndex === null);
  if (unindexed !== undefined) return `AST reference row ${String(unindexed.row.ordinal)} has no text or no astIndex`;
  if (!isDense(ast.map(({ row }) => row.astIndex ?? -1))) return 'the AST reference rows\' astIndex values have a gap or a repeat';
  if (ast.length !== blob.linkCount) return `${String(ast.length)} AST reference rows against linkCount ${String(blob.linkCount)}`;
  if (rows.sections.length !== blob.headingCount) {
    return `${String(rows.sections.length)} section rows against headingCount ${String(blob.headingCount)}`;
  }
  if (!isDense(rows.sections.map((row) => row.ordinal))) return 'the section rows\' ordinals have a gap or a repeat';
  const findingFault = findingRowsFault(blob, rows);
  if (findingFault !== undefined) return findingFault;
  return rows.conditions.some((row) => row.code === 'UNRESOLVED_REFERENCE' && row.line === null)
    ? 'an UNRESOLVED_REFERENCE row has no line'
    : undefined;
}

/**
 * Why a key's `blobs` row and the rows filed under it cannot be rebuilt into
 * facts, or `undefined` when they can: exactly the refusals of {@link factsOf},
 * which runs these same checks before it builds anything. The frontmatter value
 * is decoded to answer and the decoded value dropped.
 *
 * @param blob - The key's `blobs` row
 * @param rows - Every row the key holds
 * @returns Why the rows cannot be trusted, or `undefined`
 */
function blobRowsFault(blob: BlobRow, rows: KeyRows): string | undefined {
  const fault = rowsFault(blob, rows, astReferences(rows.references));
  if (fault !== undefined) return fault;
  const frontmatter = frontmatterOf(blob);
  return frontmatter.ok ? undefined : frontmatter.reason;
}

/**
 * @param blob - The key's `blobs` row
 * @param rows - Every row the key holds
 * @returns The resource facts, or why the rows cannot be trusted
 */
function factsOf(blob: BlobRow, rows: KeyRows): Rebuilt<BlobResourceFacts> {
  // The checks of `blobRowsFault`, in its order, with the decoded frontmatter kept.
  const ast = astReferences(rows.references);
  const fault = rowsFault(blob, rows, ast);
  if (fault !== undefined) return { ok: false, reason: fault };
  const frontmatter = frontmatterOf(blob);
  if (!frontmatter.ok) return frontmatter;
  const parseErrors = findings(rows, 'HTML_PARSE_ERROR').map((row) => buildFrom(HTML_PARSE_ERROR_FIELDS, row));
  return {
    ok: true,
    value: {
      links: linksOf(ast),
      headings: headingsOf(rows.sections),
      ...(blob.anchors.length > 0 && { anchors: blob.anchors }),
      ...(parseErrors.length > 0 && { parseErrors }),
      // Present for every markdown parse, empty or not; no other parser produces the field.
      ...(parserKindOf(blob.contentKey) === 'markdown' && { unresolvedReferences: unresolvedOf(rows) }),
      ...(frontmatter.value !== undefined && { frontmatter: frontmatter.value }),
      ...(blob.frontmatterError !== null && { frontmatterError: blob.frontmatterError }),
      estimatedTokenCount: blob.tokenEstimate,
      contentKey: blob.contentKey,
    },
  };
}

/**
 * The parser's links, in the parser's order (`astIndex`), never source order.
 * Each link's keys are in the order every parser writes them (`ResourceLink`'s
 * own: text, href, type, line, startOffset, endOffset, nodeType).
 *
 * @param ast - The key's AST reference rows, already found sound by {@link rowsFault}
 * @returns The links
 */
function linksOf(ast: readonly AstReference[]): BlobLink[] {
  return [...ast]
    .sort((left, right) => (left.row.astIndex ?? 0) - (right.row.astIndex ?? 0))
    .map(({ row, nodeType }) => ({
      text: row.text ?? '',
      href: row.rawRef,
      type: classifyLink(row.rawRef),
      ...(row.line !== null && { line: row.line }),
      ...(row.startOffset !== null && { startOffset: row.startOffset }),
      ...(row.endOffset !== null && { endOffset: row.endOffset }),
      nodeType,
    }));
}

/**
 * The heading tree, slugged by replaying the one stateful slugger over the titles in
 * document order - exactly as the parse slugged them - and nested the parse's way.
 *
 * @param sections - The key's section rows
 * @returns The heading tree
 */
function headingsOf(sections: readonly BlobSectionRow[]): ResourceMetadata['headings'] {
  return toHeadingTree([...sections].sort(byOrdinal).map((row) => buildFrom(FLAT_HEADING_FIELDS, row)));
}

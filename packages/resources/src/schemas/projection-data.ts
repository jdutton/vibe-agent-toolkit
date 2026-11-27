/**
 * The `data` instance's rows: what a data file (JSON, JSONC) says, one row set per
 * `(blob, variant)`.
 *
 * Stored (row-set tables, `ROW_SET_TABLES`): `data__files` (the head), `data__documents`,
 * `data__nodes`, `data__conditions`. Every row carries `blob` and `variant`, which lead every
 * primary key: the row set is the unit a store writes, reads and evicts, and its rows are a pure
 * function of the bytes and the variant.
 *
 * Derived per run, never stored (`DERIVED_TABLES`, producer `data`): `data__routes` (which path
 * routed to which pair, and the pair's state) and `data__values` (the routes joined to the nodes
 * no later sibling shadows).
 *
 * **Depth, one meaning:** the document root node has `depth` 1 and each child its parent's plus
 * one, the nesting count the `outputDepth` limit measures; a document's `maxDepth` is the largest
 * `depth` of a container node, 0 when the root is a scalar.
 */

import { SeveritySchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import { ContentKeySchema } from '../content-key.js';
import { scalarColumn } from '../projection/column-kinds.js';

/** The variants the `data` instance parses: each fixes its parser options. */
export const DataVariantSchema = z.enum(['json', 'jsonc'])
  .describe('How the bytes were parsed: `json` strict (no comments, no trailing commas), `jsonc` with comments and trailing commas');

/** One {@link DataVariantSchema} member. */
export type DataVariant = z.infer<typeof DataVariantSchema>;

/** The instance whose row sets these tables hold. */
export const DATA_INSTANCE = 'data';

/** The `data` instance's id. */
export type DataInstance = typeof DATA_INSTANCE;

/** What a data node is, as the source wrote it. */
export const DataNodeTypeSchema = z.enum(['object', 'array', 'string', 'number', 'boolean', 'null'])
  .describe('The node\'s type as the source wrote it');

/** One {@link DataNodeTypeSchema} member. */
export type DataNodeType = z.infer<typeof DataNodeTypeSchema>;

/** The conditions a data file's parse reports beside its rows. */
const DataConditionCodeSchema = z.enum(['DATA_DUPLICATE_KEY', 'DATA_LOSSY_NUMBER'])
  .describe('`DATA_DUPLICATE_KEY`: a key repeated in one object (the later member wins); `DATA_LOSSY_NUMBER`: a number whose lexeme\'s exact decimal value differs from that of its double\'s shortest round-trip form, or whose double is not finite');

/**
 * Where a routed pair's facts stand. The one statement of what each state means: the pair-codes
 * list in `docs/validation-codes.md` (data instance codes) is held to it by a unit test, and every
 * other document links there rather than restating it.
 */
const DataRouteStateSchema = z.enum(['facts', 'defective', 'refused'])
  .describe('`facts`: the pair\'s rows are held; `defective`: the bytes or the file decide it (malformed, not text, a lone surrogate, a cap the bytes decide, a read the filesystem refused or failed), so the same file fails the same way every run: fix the file or exclude it in resources.extractors.data; `refused`: this run decided it (a time, heap or stack cap, a worker death, bytes changed or gone under the run, the machine out of descriptors or the path busy), so a rerun may answer');

const BLOB_DESC = 'The content key of the bytes these rows describe';
const DOC_DESC = '0-based document ordinal within the file; JSON has one, 0';
const LINE_DESC = '1-based line, over the decoded text (BOM stripped); CR, LF and CRLF each one break';
const COLUMN_DESC = '1-based column in UTF-16 code units';
const NODE_COUNT_DESC = 'Nodes, containers included';
const MAX_DEPTH_DESC = 'The largest depth of a container node; 0 when the root is a scalar';

const count = (): z.ZodNumber => z.number().int().nonnegative();
const position = (): z.ZodNumber => z.number().int().positive();

/**
 * The columns that place a node in its document, shared by `data__nodes` and `data__values` in this
 * order. Spread where they stand: an object's key order is the column order the registry derives.
 */
const NODE_PATH_COLUMNS = {
  pointer: z.string().describe('RFC 6901 JSON Pointer of the node; the empty string at the root'),
  key: z.string().nullable().describe('The member key, or null for an array element or the root'),
} as const;

/** The columns that type a node and carry its value, shared by `data__nodes` and `data__values` in this order. */
const NODE_VALUE_COLUMNS = {
  depth: position().describe('The root is 1; each child is its parent\'s depth plus 1'),
  type: DataNodeTypeSchema,
  value: scalarColumn({ type: 'type', lexeme: 'lexeme' })
    .describe('A scalar node\'s value: the string, number or boolean; null for null, an object or an array'),
  lexeme: z.string().nullable().describe('A number\'s source text, or null for any other type'),
} as const;

/** A row of the `data__files` table, the instance's head: one per stored row set. */
export const DataFileRowSchema = z.object({
  blob: ContentKeySchema.describe(BLOB_DESC),
  variant: DataVariantSchema,
  documents: count().describe('Documents in the file; JSON has one'),
  bom: z.boolean().describe('Whether the bytes began with a byte order mark'),
  nodeCount: count().describe(NODE_COUNT_DESC),
  maxDepth: count().describe(MAX_DEPTH_DESC),
}).strict().describe('A row of the `data__files` table');

export type DataFileRow = z.infer<typeof DataFileRowSchema>;

/** A row of the `data__documents` table. */
export const DataDocumentRowSchema = z.object({
  blob: ContentKeySchema.describe(BLOB_DESC),
  variant: DataVariantSchema,
  doc: count().describe(DOC_DESC),
  rootType: DataNodeTypeSchema,
  nodeCount: count().describe(NODE_COUNT_DESC),
  maxDepth: count().describe(MAX_DEPTH_DESC),
}).strict().describe('A row of the `data__documents` table');

export type DataDocumentRow = z.infer<typeof DataDocumentRowSchema>;

/** A row of the `data__nodes` table: one per node, pre-order, containers included. */
export const DataNodeRowSchema = z.object({
  blob: ContentKeySchema.describe(BLOB_DESC),
  variant: DataVariantSchema,
  doc: count().describe(DOC_DESC),
  ordinal: count().describe('0-based pre-order position within the document'),
  parent: count().nullable().describe('The parent node\'s ordinal, or null at the root'),
  ...NODE_PATH_COLUMNS,
  idx: count().nullable().describe('The 0-based array index, or null for a member or the root'),
  ...NODE_VALUE_COLUMNS,
  childCount: count().describe('Direct children; 0 for a scalar'),
  shadowed: z.boolean().describe('Whether a later sibling with the same key shadows this node or an ancestor (the last occurrence wins)'),
  line: position().describe(`${LINE_DESC}; at the member's key when it has one`),
  column: position().describe(COLUMN_DESC),
}).strict().describe('A row of the `data__nodes` table');

export type DataNodeRow = z.infer<typeof DataNodeRowSchema>;

/** A row of the `data__conditions` table. */
export const DataConditionRowSchema = z.object({
  blob: ContentKeySchema.describe(BLOB_DESC),
  variant: DataVariantSchema,
  doc: count().describe(DOC_DESC),
  seq: count().describe('0-based position among the document\'s conditions, in the order the parse reported them'),
  node: count().nullable().describe('The ordinal of the node the condition is about, or null'),
  code: DataConditionCodeSchema,
  severity: SeveritySchema,
  message: z.string(),
  line: position().describe(LINE_DESC),
  column: position().describe(COLUMN_DESC),
}).strict().describe('A row of the `data__conditions` table');

export type DataConditionRow = z.infer<typeof DataConditionRowSchema>;

/** A row of the derived `data__routes` relation: one per routed path. */
export const DataRouteRowSchema = z.object({
  root: z.string().describe('The id of the root the path is under'),
  path: z.string().describe('The routed file, relative to its root'),
  blob: ContentKeySchema.nullable().describe('The content key of the bytes, or null when the run holds none'),
  variant: DataVariantSchema,
  state: DataRouteStateSchema,
  code: z.string().nullable().describe('Why the pair is not `facts`, or null when it is'),
}).strict().describe('A row of the derived `data__routes` relation');

export type DataRouteRow = z.infer<typeof DataRouteRowSchema>;

/** A row of the derived `data__values` relation: the routes joined to the unshadowed nodes. */
export const DataValueRowSchema = z.object({
  root: z.string().describe('The id of the root the path is under'),
  path: z.string().describe('The routed file, relative to its root'),
  variant: DataVariantSchema,
  doc: count().describe(DOC_DESC),
  ...NODE_PATH_COLUMNS,
  ...NODE_VALUE_COLUMNS,
  line: position().describe(LINE_DESC),
}).strict().describe('A row of the derived `data__values` relation');

export type DataValueRow = z.infer<typeof DataValueRowSchema>;

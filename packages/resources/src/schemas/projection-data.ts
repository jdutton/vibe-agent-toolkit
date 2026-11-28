/**
 * The `data` instance's rows: what a data file (JSON, JSONC, YAML, `.npmrc`) says, one row set per
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
 *
 * **Aliases, expanded:** a YAML alias is a copy of the node its anchor names, one row per copied
 * node, each carrying `aliasOf`; JSON writes no tag and no alias, so both columns are null there.
 */

import { SeveritySchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import { ContentKeySchema } from '../content-key.js';
import { scalarColumn } from '../projection/column-kinds.js';

import { BLOB_DESC, COLUMN_DESC, count, LINE_DESC, position, ROOT_PATH_COLUMNS, routeRowSchema } from './projection-row-set-columns.js';

/** The variants the `data` instance parses: each fixes its parser options. */
export const DataVariantSchema = z.enum(['json', 'jsonc', 'yaml', 'ini'])
  .describe('How the bytes were parsed: `json` strict (no comments, no trailing commas), `jsonc` with comments and trailing commas, `yaml` as a YAML 1.2 stream under the core schema (every document, aliases expanded, `<<` a plain key), `ini` an `.npmrc` read by npm\'s `ini` package as one object holding only its allowlisted top-level keys (every other key and every section dropped)');

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
const DataConditionCodeSchema = z.enum(['DATA_DUPLICATE_KEY', 'DATA_LOSSY_NUMBER', 'DATA_NON_STRING_KEY'])
  .describe('`DATA_DUPLICATE_KEY`: a key repeated in one object (the later member wins); `DATA_LOSSY_NUMBER`: a number whose lexeme\'s exact value differs from that of its double, or whose double is not finite; `DATA_NON_STRING_KEY`: a YAML key that is not a string (a number, boolean, null or collection), keyed by its source text');

const DOC_DESC = '0-based document ordinal within the file; JSON has one, 0; a YAML stream 0..n-1';
const NODE_COUNT_DESC = 'Nodes, containers included';
const MAX_DEPTH_DESC = 'The largest depth of a container node; 0 when the root is a scalar';

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
  documents: count().describe('Documents in the file; JSON has one, a YAML stream any number, 0 when it holds none'),
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
  tag: z.string().nullable().describe('The node\'s explicit tag as YAML resolves it (`!!str` is `tag:yaml.org,2002:str`, `!foo` stays `!foo`), or null when the source wrote none; always null for JSON'),
  aliasOf: count().nullable().describe('The ordinal of the node this row copies when a YAML alias expanded it (the anchored node for the alias\'s own row, the corresponding row for each copied descendant), or null when no alias produced it'),
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
export const DataRouteRowSchema = routeRowSchema(DataVariantSchema, 'data__routes');

export type DataRouteRow = z.infer<typeof DataRouteRowSchema>;

/** A row of the derived `data__values` relation: the routes joined to the unshadowed nodes. */
export const DataValueRowSchema = z.object({
  ...ROOT_PATH_COLUMNS,
  variant: DataVariantSchema,
  doc: count().describe(DOC_DESC),
  ...NODE_PATH_COLUMNS,
  ...NODE_VALUE_COLUMNS,
  line: position().describe(LINE_DESC),
}).strict().describe('A row of the derived `data__values` relation');

export type DataValueRow = z.infer<typeof DataValueRowSchema>;

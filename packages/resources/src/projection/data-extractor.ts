/**
 * The `data` instance's extractor: one JSON or JSONC document's decoded text in,
 * its row set out (`data__files`, `data__documents`, `data__nodes`,
 * `data__conditions`), minus the `blob` and `variant` columns the data stage adds.
 *
 * It runs in the parse worker only (ADR I8): `parser-loader.ts` is its one
 * importer, held by `packages/dev-tools/test/parser-import-boundary.test.ts`.
 *
 * ## Structure before the parse
 *
 * `jsonc-parser`'s `parseTree` recurses once per open bracket or brace, and its
 * error recovery skips a closer that does not match, so a deep or malformed
 * document would overflow the worker's stack before any cap saw it. The text is
 * scanned first with the library's own scanner, a loop over tokens that keeps a
 * stack of the containers open: a closer that does not match the innermost open
 * container, or closes one when none is open, is a `DATA_PARSE_ERROR` without a
 * parse, so every text the parser sees nests exactly as deep as the scan
 * measured. A container is one level deeper than the one holding it, a scalar
 * root measures 0 (the convention `expandedSize` in `parse-limits.ts` keeps).
 * Past `outputDepth` the document is refused without being parsed.
 *
 * ## Rows
 *
 * Nodes in pre-order, containers included. A member is placed at its key; line
 * and column are 1-based, the column in UTF-16 code units, and CR, LF and CRLF
 * are one line break each. The last occurrence of a key wins: every earlier
 * occurrence and all of its descendants are `shadowed`, and each occurrence
 * after the first raises one `DATA_DUPLICATE_KEY` at the later member. A number
 * whose lexeme's exact decimal value differs from that of its double's shortest
 * round-trip form, or whose double is not finite, raises `DATA_LOSSY_NUMBER`.
 * The whole row set is held to the output caps by `factsOutputBreach`, the one
 * rule every worker answer is held to.
 *
 * A key or string holding a lone UTF-16 surrogate (an unpaired escape in
 * U+D800 to U+DFFF, which RFC 8259 admits) is `DATA_LONE_SURROGATE`: no UTF-8
 * text holds it, so two such keys a JavaScript string tells apart would be
 * stored as one.
 */

import { createRequire } from 'node:module';

import type * as JsoncParser from 'jsonc-parser';

import { factsOutputBreach, type ParseLimits } from '../parse-limits.js';
import type {
  DataConditionRow,
  DataDocumentRow,
  DataFileRow,
  DataNodeRow,
  DataNodeType,
  DataVariant,
} from '../schemas/projection-data.js';
import { encodeJsonPointerSegment } from '../utils.js';

/**
 * `jsonc-parser`, loaded by a literal `createRequire`: its `main` is a UMD
 * bundle and it has no `exports` map, so an ESM `import` of it does not resolve
 * its named exports. The version is pinned in `package.json` and by a test.
 */
const jsonc = createRequire(import.meta.url)('jsonc-parser') as typeof JsoncParser;

/** A row of the instance's tables minus the pair the data stage adds: the extractor never sees the content key. */
type WithoutPair<Row> = Omit<Row, 'blob' | 'variant'>;

/** `data__files` minus `blob` and `variant`. */
export type ExtractedDataFile = WithoutPair<DataFileRow>;

/** `data__documents` minus `blob` and `variant`. */
export type ExtractedDataDocument = WithoutPair<DataDocumentRow>;

/** `data__nodes` minus `blob` and `variant`. */
export type ExtractedDataNode = WithoutPair<DataNodeRow>;

/** `data__conditions` minus `blob` and `variant`. */
export type ExtractedDataCondition = WithoutPair<DataConditionRow>;

/** The condition codes a clean extraction may raise; neither is a defect. */
type DataConditionCode = DataConditionRow['code'];

/** One document's row set, minus the `blob` and `variant` columns. */
export interface ExtractedDataRows {
  readonly files: readonly [ExtractedDataFile];
  readonly documents: readonly ExtractedDataDocument[];
  readonly nodes: readonly ExtractedDataNode[];
  readonly conditions: readonly ExtractedDataCondition[];
}

/** The output caps an extraction is held to. */
type DataOutputLimitName = 'outputDepth' | 'outputRows' | 'outputBytes';

/** The document defects the bytes alone decide. */
export type DataDefectCode = 'DATA_PARSE_ERROR' | 'DATA_LONE_SURROGATE';

/**
 * What one extraction answers: the rows; a document defect the bytes alone
 * decide ({@link DataDefectCode}); or an output cap the bytes breach. The breach is
 * a value, not a throw, so the worker can post the limit and what was found as
 * it does for every other job (`settleJob` in `parse-pool.ts` turns it into a
 * `ParseLimitError`).
 */
export type DataExtraction =
  | { readonly outcome: 'rows'; readonly rows: ExtractedDataRows }
  | { readonly outcome: 'defect'; readonly code: DataDefectCode; readonly message: string }
  | { readonly outcome: 'breach'; readonly limit: DataOutputLimitName; readonly found: number };

/**
 * What a data job settles to on the pool: the rows or the document's defect. A
 * breach never resolves; the pool rejects it as a `ParseLimitError`.
 */
export type DataRowsAnswer = Exclude<DataExtraction, { readonly outcome: 'breach' }>;

/** One document to extract. */
export interface DataExtractInput {
  /** The decoded text, BOM stripped. */
  readonly text: string;
  readonly variant: DataVariant;
  /** Whether the bytes carried a BOM (the decode's `encodingSource === 'bom'`). */
  readonly bom: boolean;
}

/** The only document a JSON file holds. */
const DOC = 0;

/** Parse options per variant: strict JSON refuses comments and trailing commas. */
const PARSE_OPTIONS: Readonly<Record<DataVariant, JsoncParser.ParseOptions>> = {
  json: { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false },
  jsonc: { disallowComments: false, allowTrailingComma: true, allowEmptyContent: false },
};

/**
 * Extract one document's row set.
 *
 * @param input - The decoded text, its variant and whether its bytes had a BOM
 * @param limits - The output caps in force
 * @returns The rows, a {@link DataDefectCode} defect, or the output cap breached
 */
export function extractDataRows(input: DataExtractInput, limits: Pick<ParseLimits, DataOutputLimitName>): DataExtraction {
  const lines = lineStarts(input.text);
  const scan = scanStructure(input.text);
  if (typeof scan !== 'number') {
    return { outcome: 'defect', code: 'DATA_PARSE_ERROR', message: placedMessage(jsonc.printParseErrorCode(scan.error), scan.offset, lines) };
  }
  const depth = scan;
  const expanded = { rows: 0, bytes: 0, depth };
  // The one cap rule, applied to the depth alone before anything recurses.
  const deep = factsOutputBreach({}, limits, expanded);
  if (deep !== undefined) return { outcome: 'breach', limit: deep.limit, found: deep.found };

  const errors: JsoncParser.ParseError[] = [];
  const root = jsonc.parseTree(input.text, errors, PARSE_OPTIONS[input.variant]);
  const [first] = errors;
  if (first !== undefined || root === undefined) {
    return { outcome: 'defect', code: 'DATA_PARSE_ERROR', message: parseErrorMessage(first, input.text.length, lines) };
  }

  const walked = walk(root, input.text, lines);
  if ('lone' in walked) {
    const what = walked.lone.inKey ? 'A key' : 'A string';
    return { outcome: 'defect', code: 'DATA_LONE_SURROGATE', message: placedMessage(`${what} holds a lone UTF-16 surrogate`, walked.lone.offset, lines) };
  }
  const { nodes, conditions } = walked;
  const rows: ExtractedDataRows = {
    files: [{ documents: 1, bom: input.bom, nodeCount: nodes.length, maxDepth: depth }],
    documents: [{ doc: DOC, rootType: root.type as DataNodeType, nodeCount: nodes.length, maxDepth: depth }],
    nodes,
    conditions,
  };
  const breach = factsOutputBreach(rows, limits, expanded);
  if (breach !== undefined) return { outcome: 'breach', limit: breach.limit, found: breach.found };
  return { outcome: 'rows', rows };
}

/** A closer the structure scan refused: the error the parse would name, and where the closer is. */
interface StructureError {
  readonly error: JsoncParser.ParseErrorCode;
  readonly offset: number;
}

/** Each closer token, by the opener it closes. */
const CLOSER_OF: ReadonlyMap<JsoncParser.SyntaxKind, JsoncParser.SyntaxKind> = new Map([
  [jsonc.SyntaxKind.OpenBraceToken, jsonc.SyntaxKind.CloseBraceToken],
  [jsonc.SyntaxKind.OpenBracketToken, jsonc.SyntaxKind.CloseBracketToken],
]);

/** The error a parse names when the innermost open container is not closed by what closes it. */
const UNCLOSED: ReadonlyMap<JsoncParser.SyntaxKind, JsoncParser.ParseErrorCode> = new Map([
  [jsonc.SyntaxKind.CloseBraceToken, jsonc.ParseErrorCode.CloseBraceExpected],
  [jsonc.SyntaxKind.CloseBracketToken, jsonc.ParseErrorCode.CloseBracketExpected],
]);

/**
 * How deep the text's containers nest, by the scanner alone (a loop, never a
 * recursion), with a stack of the closers the open containers expect: each
 * open brace or bracket is one level deeper than the one holding it. A closer
 * that matches no open container ends the scan, because the parse would skip
 * it and keep nesting past the depth measured.
 *
 * @param text - The document
 * @returns The deepest nesting (0 for a scalar root), or the mismatched closer
 */
function scanStructure(text: string): number | StructureError {
  const scanner = jsonc.createScanner(text, true);
  const expected: JsoncParser.SyntaxKind[] = [];
  let deepest = 0;
  let scanned = 0;
  for (let kind = scanner.scan(); kind !== jsonc.SyntaxKind.EOF; kind = scanner.scan(), scanned += 1) {
    const closer = CLOSER_OF.get(kind);
    if (closer !== undefined) {
      expected.push(closer);
      deepest = Math.max(deepest, expected.length);
    } else if (UNCLOSED.has(kind)) {
      const innermost = expected.pop();
      if (innermost === kind) continue;
      const offset = scanner.getTokenOffset();
      if (innermost !== undefined) return { error: UNCLOSED.get(innermost) as JsoncParser.ParseErrorCode, offset };
      const error = scanned === 0 ? jsonc.ParseErrorCode.ValueExpected : jsonc.ParseErrorCode.EndOfFileExpected;
      return { error, offset };
    }
  }
  return deepest;
}

/**
 * The offset each line starts at. CR, LF and CRLF are one break each.
 *
 * @param text - The document
 * @returns Line start offsets, ascending, the first 0
 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    // A code point is read at every code-unit index; CR and LF are never part of a surrogate pair.
    const char = text.codePointAt(index);
    if (char === CR && text.codePointAt(index + 1) === LF) continue;
    if (char === CR || char === LF) starts.push(index + 1);
  }
  return starts;
}

const CR = 0x0d;
const LF = 0x0a;

/** A 1-based line and column (UTF-16 code units). */
interface Position {
  readonly line: number;
  readonly column: number;
}

/**
 * @param offset - A UTF-16 offset into the text
 * @param starts - {@link lineStarts} of the text
 * @returns Its 1-based line and column
 */
function positionOf(offset: number, starts: readonly number[]): Position {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - (starts[low] as number) + 1 };
}

/**
 * @param error - The parse's first error, if it reported one
 * @param length - The text's length, where an error-less refusal (no root) is placed
 * @param starts - {@link lineStarts} of the text
 * @returns The `DATA_PARSE_ERROR` message: the error's code name and where it is
 */
function parseErrorMessage(error: JsoncParser.ParseError | undefined, length: number, starts: readonly number[]): string {
  const name = error === undefined ? 'ValueExpected' : jsonc.printParseErrorCode(error.error);
  return placedMessage(name, error?.offset ?? length, starts);
}

/**
 * @param what - What is wrong
 * @param offset - Where, as a UTF-16 offset into the text
 * @param starts - {@link lineStarts} of the text
 * @returns A defect's message: what, then its 1-based line and column
 */
function placedMessage(what: string, offset: number, starts: readonly number[]): string {
  const { line, column } = positionOf(offset, starts);
  return `${what} at line ${String(line)}, column ${String(column)}`;
}

/** A value node waiting to be numbered, with what its parent decided about it. */
interface PendingNode {
  readonly node: JsoncParser.Node;
  readonly parent: number | null;
  readonly pointer: string;
  readonly key: string | null;
  readonly idx: number | null;
  readonly depth: number;
  readonly shadowed: boolean;
  /** Where the node is placed: its member's key when it has one, else itself. */
  readonly offset: number;
  /**
   * The pointer of the object holding it when its key repeats an earlier
   * sibling's (one `DATA_DUPLICATE_KEY`); null when it does not.
   */
  readonly repeatIn: string | null;
}

/** Where a key or string holds a lone surrogate. */
interface LoneSurrogate {
  readonly inKey: boolean;
  readonly offset: number;
}

/**
 * @param pending - A node and its parent's decisions
 * @returns Where its key, or its string value, holds a lone surrogate; undefined when neither does
 */
function loneSurrogateIn(pending: PendingNode): LoneSurrogate | undefined {
  if (pending.key !== null && !pending.key.isWellFormed()) return { inKey: true, offset: pending.offset };
  const { node } = pending;
  if (node.type === 'string' && !(node.value as string).isWellFormed()) return { inKey: false, offset: node.offset };
  return undefined;
}

/**
 * Number every node in pre-order and raise the conditions, by an explicit
 * stack (never a recursion). The first key or string holding a lone surrogate
 * ends the walk: the document has no rows.
 *
 * @param root - The parsed tree, error-free
 * @param text - The document
 * @param starts - {@link lineStarts} of the text
 * @returns The node and condition rows, or the first lone surrogate
 */
function walk(
  root: JsoncParser.Node,
  text: string,
  starts: readonly number[],
): { nodes: ExtractedDataNode[]; conditions: ExtractedDataCondition[] } | { lone: LoneSurrogate } {
  const nodes: ExtractedDataNode[] = [];
  const conditions: ExtractedDataCondition[] = [];
  const stack: PendingNode[] = [
    { node: root, parent: null, pointer: '', key: null, idx: null, depth: 1, shadowed: false, offset: root.offset, repeatIn: null },
  ];
  while (stack.length > 0) {
    const pending = stack.pop() as PendingNode;
    const lone = loneSurrogateIn(pending);
    if (lone !== undefined) return { lone };
    const row = nodeRow(pending, nodes.length, text, starts);
    nodes.push(row);
    for (const condition of conditionsOf(pending, row)) {
      conditions.push({ doc: DOC, seq: conditions.length, node: row.ordinal, severity: 'warning', line: row.line, column: row.column, ...condition });
    }
    const children = childrenOf(pending, row.ordinal);
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index] as PendingNode);
  }
  return { nodes, conditions };
}

/**
 * @param pending - The node and its parent's decisions
 * @param ordinal - Its pre-order number
 * @param text - The document
 * @param starts - {@link lineStarts} of the text
 * @returns Its row
 */
function nodeRow(pending: PendingNode, ordinal: number, text: string, starts: readonly number[]): ExtractedDataNode {
  const { node } = pending;
  const type = node.type as DataNodeType;
  const lexeme = type === 'number' ? text.slice(node.offset, node.offset + node.length) : null;
  return {
    doc: DOC,
    ordinal,
    parent: pending.parent,
    pointer: pending.pointer,
    key: pending.key,
    idx: pending.idx,
    depth: pending.depth,
    type,
    value: scalarValue(node, lexeme),
    lexeme,
    childCount: node.children?.length ?? 0,
    shadowed: pending.shadowed,
    ...positionOf(pending.offset, starts),
  };
}

/**
 * @param node - A parsed node
 * @param lexeme - Its source text when it is a number
 * @returns Its scalar value: the number its lexeme reads as (`-0` as `0`), the
 *   string or boolean; null for null, an object or an array
 */
function scalarValue(node: JsoncParser.Node, lexeme: string | null): string | number | boolean | null {
  if (lexeme !== null) {
    const number = Number(lexeme);
    return number === 0 ? 0 : number;
  }
  if (node.type === 'string' || node.type === 'boolean') return node.value as string | boolean;
  return null;
}

/**
 * The conditions one node raises, in a fixed order: a repeated key, then a lossy number.
 *
 * @param pending - The node and its parent's decisions
 * @param row - Its row
 * @returns The conditions' code and message
 */
function conditionsOf(pending: PendingNode, row: ExtractedDataNode): { code: DataConditionCode; message: string }[] {
  const raised: { code: DataConditionCode; message: string }[] = [];
  if (pending.repeatIn !== null) {
    const where = pending.repeatIn === '' ? 'the document root' : pending.repeatIn;
    raised.push({
      code: 'DATA_DUPLICATE_KEY',
      message: `The key ${JSON.stringify(pending.key)} repeats in the object at ${where}; the last occurrence wins.`,
    });
  }
  if (row.lexeme !== null && isLossy(row.lexeme)) {
    raised.push({
      code: 'DATA_LOSSY_NUMBER',
      message: `The number ${row.lexeme} is not exactly a double; it reads as ${String(Number(row.lexeme))}.`,
    });
  }
  return raised;
}

/**
 * A container's children, in document order, with what this container decides
 * about each: pointer, key or index, depth, and whether a later sibling with the
 * same key shadows it.
 *
 * @param pending - The container (or a scalar, which has none)
 * @param ordinal - Its pre-order number, the children's parent
 * @returns Its children
 */
function childrenOf(pending: PendingNode, ordinal: number): PendingNode[] {
  const { node } = pending;
  const children = node.children ?? [];
  const below = { parent: ordinal, depth: pending.depth + 1 };
  if (node.type === 'array') {
    return children.map((child, idx) => ({
      ...below,
      node: child,
      pointer: `${pending.pointer}/${String(idx)}`,
      key: null,
      idx,
      shadowed: pending.shadowed,
      offset: child.offset,
      repeatIn: null,
    }));
  }
  if (node.type !== 'object') return [];
  const keys = children.map((property) => property.children?.[0]?.value as string);
  const lastIndex = new Map(keys.map((key, index) => [key, index]));
  const seen = new Set<string>();
  return children.map((property, index) => {
    const key = keys[index] as string;
    const repeat = seen.has(key);
    seen.add(key);
    return {
      ...below,
      node: property.children?.[1] as JsoncParser.Node,
      pointer: `${pending.pointer}/${encodeJsonPointerSegment(key)}`,
      key,
      idx: null,
      shadowed: pending.shadowed || lastIndex.get(key) !== index,
      offset: property.offset,
      repeatIn: repeat ? pending.pointer : null,
    };
  });
}

/** A JSON number lexeme's exact decimal value: sign, significant digits, and the power of ten they scale by. */
interface ExactDecimal {
  readonly negative: boolean;
  readonly digits: string;
  readonly exponent: number;
}

/** The character `0`. */
const ZERO = 0x30;

/**
 * Whether a number lexeme is lossy: its exact decimal value differs from the
 * exact decimal value of the double's shortest round-trip form
 * (`String(Number(lexeme))`), or the double is not finite. So `0.1` is exact,
 * `9007199254740993` and `1e400` are not.
 *
 * @param lexeme - The number's source text
 * @returns True when the double does not hold the lexeme's value
 */
function isLossy(lexeme: string): boolean {
  const number = Number(lexeme);
  if (!Number.isFinite(number)) return true;
  const exact = exactDecimal(lexeme);
  const held = exactDecimal(String(number));
  return exact.negative !== held.negative || exact.digits !== held.digits || exact.exponent !== held.exponent;
}

/**
 * @param lexeme - A JSON number lexeme (RFC 8259: the parse admitted it), or
 *   `String(number)` of a finite number, which writes the same grammar
 * @returns Its exact decimal value, normalised so equal values compare equal
 *   (zero has no sign, no digits and exponent 0)
 */
function exactDecimal(lexeme: string): ExactDecimal {
  const negative = lexeme.startsWith('-');
  const unsigned = negative ? lexeme.slice(1) : lexeme;
  const marker = Math.max(unsigned.indexOf('e'), unsigned.indexOf('E'));
  const mantissa = marker === -1 ? unsigned : unsigned.slice(0, marker);
  const power = marker === -1 ? 0 : Number(unsigned.slice(marker + 1));
  const dot = mantissa.indexOf('.');
  const fraction = dot === -1 ? '' : mantissa.slice(dot + 1);
  const significant = dot === -1 ? mantissa : `${mantissa.slice(0, dot)}${fraction}`;
  // Loops, not `/0+$/`: a trailing-run regex backtracks quadratically on a long lexeme.
  let first = 0;
  while (first < significant.length && significant.codePointAt(first) === ZERO) first += 1;
  let end = significant.length;
  while (end > first && significant.codePointAt(end - 1) === ZERO) end -= 1;
  if (end === first) return { negative: false, digits: '', exponent: 0 };
  const trailingZeros = significant.length - end;
  return { negative, digits: significant.slice(first, end), exponent: power - fraction.length + trailingZeros };
}

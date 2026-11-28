/**
 * The `data` instance's extractor for variant `yaml`: one YAML stream's decoded
 * text in, its row set out, in the same `data__*` shape the JSON variants fill.
 *
 * It runs in the parse worker only (ADR I8): `data-extractor.ts` is its one
 * importer, held by `packages/dev-tools/test/parser-import-boundary.test.ts`.
 * The rules every variant shares (positions, last occurrence wins, lossy
 * numbers, the caps) are `data-row-rules.ts`; this module decides only what
 * YAML adds.
 *
 * ## The parse
 *
 * `yaml` (the repository's one YAML library) under YAML 1.2 and its core
 * schema, with duplicate keys admitted (`uniqueKeys: false`, so the shared
 * last-occurrence rule decides them), `<<` merges off (`merge: false`: a
 * `<<` key is stored literally, with its value, never merged) and the YAML 1.1
 * tags off (`resolveKnownTags: false`): `!!binary`, `!!timestamp`, `!!omap`,
 * `!!pairs` and `!!set` are recorded as the node's tag and read as the 1.2 core
 * node they are written as (a string, a sequence, a map), never decoded. The
 * stream is composed by the library's own `Parser` and `Composer`, the two
 * halves of `parseAllDocuments`, one token at a time, so each directive and
 * each document is seen before the next is composed: a `%YAML` directive
 * naming any version but 1.2 is `DATA_YAML_VERSION` (the library itself reads
 * 1.1 under the 1.1 schema, and an unsupported version as 1.2 with only a
 * warning). Any document or stream error is `DATA_PARSE_ERROR`, the earliest
 * one, placed; a warning (an unresolved tag) is not a defect.
 *
 * The composer recurses on nesting, and the library turns its own stack
 * overflow into an error (`RESOURCE_EXHAUSTION`), so how deep a document can
 * nest before composing fails is the thread's stack, not the bytes. Each
 * document's token tree is measured first, by an explicit stack: a collection
 * nested past `outputDepth` (a key's nesting counts too) is that breach
 * without being composed, so at the default stack no document the cap admits
 * overflows it. Should one still (a smaller `stackMb`), the error is thrown,
 * never a parse error: the worker reports it as the `stackMb` breach
 * (`isStackOverflow`), `refused`, never stored. And composing stops once the documents alone pass `outputRows`
 * (each is at least a document row and a node row), so a stream of many small
 * documents is never held whole.
 *
 * ## Positions
 *
 * From the shared line table, not the library's `LineCounter`: CR, LF and CRLF
 * are one break each and columns count UTF-16 code units, exactly as for JSON.
 * YAML 1.2 makes a lone CR a line break but the library's lexer does not, so
 * the composer is handed the text with each lone CR read as LF (one code unit
 * for one: every offset holds) and parses the lines the table counts.
 * A member is placed at its key; any other node at its value (after any tag or
 * anchor).
 *
 * ## Rows
 *
 * Documents are `doc` 0..n-1, each with its own ordinals and conditions; the
 * head row sums their nodes and takes their deepest container. An empty stream
 * has a head row of no documents and nothing else; a document with no content
 * (`---` alone) is one null root. A map is `object`, a sequence `array`, a
 * scalar its core-schema value's type. A number's `lexeme` is its source text
 * and its `value` the double the library resolves; the storage class still
 * follows the unchanged lexeme rule of the row encoder, so `0x1F` and `+1`
 * store as REAL. A non-finite number (`.inf`, `.nan`) or one whose double does
 * not hold it raises `DATA_LOSSY_NUMBER`. `tag` is the node's explicit tag as
 * the library resolves it, null when the source wrote none.
 *
 * A key that is not a string (a number, boolean, null or collection) keys its
 * member by its trimmed source text, escaped into the pointer like any key, and
 * raises `DATA_NON_STRING_KEY`; shadowing compares that text.
 *
 * ## Aliases
 *
 * Expanded, by the same explicit stack that numbers every node (never a
 * recursion): an alias is a row copying the node its anchor names, and each of
 * that node's descendants is copied below it. Every row an expansion produces
 * carries `aliasOf`, the ordinal of the row it corresponds to in the anchored
 * subtree (that subtree's rows come first in pre-order and have the same
 * shape, so the k-th row of an expansion copies the anchored row plus k). A
 * copy inside a copy is part of the outer one. An anchor on a key has no row,
 * so an expansion of it has `aliasOf` null. The alias's own row is placed at
 * the alias (at its member's key when it has one); copied descendants keep
 * their original's line and column. An alias naming no anchor before it is
 * `DATA_PARSE_ERROR`.
 *
 * Rows are counted as they are produced, and the walk stops the moment the row
 * set passes `outputRows`, a container passes `outputDepth`, or the rows'
 * bytes pass `outputBytes`: an alias bomb (or a self-referencing anchor, or
 * one long anchored string aliased many times) is a breach before its
 * expansion is ever written out. The bytes are counted as a floor of each
 * row's JSON ({@link rowBytesFloor}), so a breach found during the walk is one
 * the whole row set breaches too. The finished row set is then held to every
 * cap by the shared rule, as the JSON variants are.
 *
 * A scalar the core schema resolves to anything but a string, number, boolean
 * or null (none does once the 1.1 tags are off) is `DATA_PARSE_ERROR` at the
 * node, never a throw.
 */

import { appendAll } from '@vibe-agent-toolkit/utils';
import {
  type Alias,
  Composer,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  type Node as YamlNode,
  Parser,
  type CST,
  type Document,
  type Pair,
  type Scalar,
  type YAMLError,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';

import type { OutputLimitName, ParseLimits } from '../parse-limits.js';
import type { DataNodeType } from '../schemas/projection-data.js';
import { encodeJsonPointerSegment } from '../utils.js';

import type {
  DataExtraction,
  ExtractedDataCondition,
  ExtractedDataDocument,
  ExtractedDataNode,
} from './data-extractor.js';
import {
  type LoneSurrogate,
  loneSurrogateDefect,
  memberOrder,
  placedMessage,
  pushNodeConditions,
  settleRows,
} from './data-row-rules.js';
import { lineStarts, positionOf } from './line-index.js';

/** The composer's options: YAML 1.2, core schema, duplicate keys admitted, `<<` a plain key, no 1.1 tags. */
const COMPOSE_OPTIONS = { version: '1.2', uniqueKeys: false, merge: false, resolveKnownTags: false, keepSourceTokens: false } as const;

/**
 * A CR not followed by LF. YAML 1.2 makes it a line break, the library's lexer
 * does not, so it is read as LF: one code unit for one, so every offset holds.
 */
const LONE_CR = /\r(?!\n)/g;

/** The one YAML version read. */
const READ_VERSION = '1.2';

/** The directive that names a version. */
const YAML_DIRECTIVE = '%YAML';

/** What separates a directive's name from its parameters (YAML 1.2 s-separate-in-line). */
const DIRECTIVE_SEPARATOR = /[ \t]+/;

/** A node an alias can name, and every node a row is made from. */
type ValueNode = Scalar | YAMLMap | YAMLSeq;

/** A composed document's root, or a member's value: a node, an alias, or nothing (an absent value). */
type Slot = ValueNode | Alias | null;

/** The output caps an extraction is held to. */
type Limits = Pick<ParseLimits, OutputLimitName>;

/**
 * Extract one YAML stream's row set.
 *
 * @param text - The decoded text, BOM stripped
 * @param bom - Whether its bytes had a BOM
 * @param limits - The output caps in force
 * @returns The rows, a defect, or the output cap breached
 */
export function extractYamlRows(text: string, bom: boolean, limits: Limits): DataExtraction {
  const lines = lineStarts(text);
  const composed = composeStream(text.replaceAll(LONE_CR, '\n'), lines, limits);
  if ('outcome' in composed) return composed;
  const { documents, errors } = composed;
  // The composer's own stack overflow, which it reports as an error: the thread's stack decides it,
  // not the bytes, so it is thrown for the worker to report as the `stackMb` breach.
  const exhausted = errors.find((candidate) => candidate.code === 'RESOURCE_EXHAUSTION');
  if (exhausted !== undefined) throw exhausted;
  const error = firstError(errors);
  if (error !== undefined) return { outcome: 'defect', code: 'DATA_PARSE_ERROR', message: placedMessage(error.code, error.pos[0], lines) };

  const walk = new StreamWalk(text, lines, limits, documents.length);
  for (const [doc, document] of documents.entries()) {
    const stopped = walk.document(doc, document.contents as Slot);
    if (stopped !== undefined) return stopped;
  }
  const { nodes, conditions, heads } = walk;
  // A loop, never a spread: a stream of many documents would pass every head as an argument.
  let maxDepth = 0;
  for (const head of heads) maxDepth = Math.max(maxDepth, head.maxDepth);
  return settleRows({
    files: [{ documents: heads.length, bom, nodeCount: nodes.length, maxDepth }],
    documents: heads,
    nodes,
    conditions,
  }, limits);
}

/** A composed stream: its documents and every error the stream and they reported. */
interface ComposedStream {
  readonly documents: readonly Document.Parsed[];
  readonly errors: readonly YAMLError[];
}

/**
 * Compose a stream one token at a time, stopping at the first `%YAML` directive naming another
 * version, the first document nested past `outputDepth`, or once the documents alone pass
 * `outputRows`.
 *
 * @param text - The text, each lone CR read as LF
 * @param lines - Its line table
 * @param limits - The output caps in force
 * @returns The documents and errors, or the defect or breach that stops the stream
 */
function composeStream(text: string, lines: readonly number[], limits: Limits): ComposedStream | DataExtraction {
  const composer = new Composer(COMPOSE_OPTIONS);
  const documents: Document.Parsed[] = [];
  for (const token of new Parser().parse(text)) {
    if (token.type === 'directive') {
      const version = versionOf(token);
      if (version !== undefined && version !== READ_VERSION) {
        return {
          outcome: 'defect',
          code: 'DATA_YAML_VERSION',
          message: placedMessage(`The %YAML ${version} directive names a version other than ${READ_VERSION}`, token.offset, lines),
        };
      }
    }
    if (token.type === 'document') {
      const depth = nestingOf(token, limits.outputDepth);
      if (depth > limits.outputDepth) return { outcome: 'breach', limit: 'outputDepth', found: depth };
    }
    appendAll(documents, [...composer.next(token)]);
    const floor = 1 + 2 * documents.length;
    if (floor > limits.outputRows) return { outcome: 'breach', limit: 'outputRows', found: floor };
  }
  appendAll(documents, [...composer.end()]);
  return { documents, errors: [...composer.streamInfo().errors, ...documents.flatMap((document) => document.errors)] };
}

/**
 * @param directive - A directive token
 * @returns The version a `%YAML` directive names (its first parameter, '' when it names none);
 *   undefined for any other directive (`%TAG`, or a reserved one such as `%YAMLX`)
 */
function versionOf(directive: CST.Directive): string | undefined {
  const [name, version] = directive.source.trim().split(DIRECTIVE_SEPARATOR);
  return name === YAML_DIRECTIVE ? version ?? '' : undefined;
}

/**
 * How deep a document's token tree nests its collections, by an explicit stack: the root
 * collection is 1, as a row's depth is, and a collection under a key counts like one under a value.
 *
 * @param document - A document token
 * @param bound - The depth past which measuring stops
 * @returns The deepest nesting, or the first past `bound`
 */
function nestingOf(document: CST.Document, bound: number): number {
  let deepest = 0;
  const stack: Array<{ readonly token: CST.Token; readonly depth: number }> = [];
  const below = (token: CST.Token | null | undefined, depth: number): void => {
    if (token?.type === 'block-map' || token?.type === 'block-seq' || token?.type === 'flow-collection') stack.push({ token, depth: depth + 1 });
  };
  below(document.value, 0);
  while (stack.length > 0) {
    const { token, depth } = stack.pop() as (typeof stack)[number];
    if (depth > bound) return depth;
    deepest = Math.max(deepest, depth);
    if (!('items' in token)) continue;
    for (const item of token.items) {
      if ('key' in item) below(item.key, depth);
      below(item.value, depth);
    }
  }
  return deepest;
}

/**
 * @param errors - Every error the stream and its documents reported
 * @returns The one earliest in the text
 */
function firstError(errors: readonly YAMLError[]): YAMLError | undefined {
  return errors.reduce<YAMLError | undefined>((first, error) => (first === undefined || error.pos[0] < first.pos[0] ? error : first), undefined);
}

/** The expansion a row is part of: the anchored row it copies from, and the ordinal the alias's own row took. */
interface Expansion {
  /** The anchored node's ordinal, or null when the anchor is on a key (which has no row). */
  readonly anchor: number | null;
  readonly start: number;
}

/** A node waiting to be numbered, with what its parent decided about it. */
interface PendingNode {
  readonly slot: Slot;
  readonly parent: number | null;
  readonly pointer: string;
  readonly key: string | null;
  readonly idx: number | null;
  readonly depth: number;
  readonly shadowed: boolean;
  /** Where the node is placed: its member's key when it has one, else itself. */
  readonly offset: number;
  /** The pointer of the object holding it when its key repeats an earlier sibling's; null when it does not. */
  readonly repeatIn: string | null;
  readonly nonStringKey: boolean;
  readonly expansion: Expansion | null;
}

/** What one document's walk resolved its aliases to. */
type AliasTargets = ReadonlyMap<Alias, ValueNode>;

/**
 * Numbers every document's nodes in turn, holding the running row count to
 * the caps as it goes.
 */
class StreamWalk {
  readonly nodes: ExtractedDataNode[] = [];
  readonly conditions: ExtractedDataCondition[] = [];
  readonly heads: ExtractedDataDocument[] = [];
  /** A floor of the rows' JSON bytes so far ({@link rowBytesFloor}). */
  private bytes = 0;

  constructor(
    private readonly text: string,
    private readonly lines: readonly number[],
    private readonly limits: Limits,
    private readonly documentCount: number,
  ) {}

  /**
   * Number one document's nodes.
   *
   * @param doc - Its ordinal in the stream
   * @param root - Its composed root
   * @returns Nothing when its rows were added; else the defect or breach that stops the stream
   */
  document(doc: number, root: Slot): DataExtraction | undefined {
    const targets = resolveAliases(root);
    if ('unresolved' in targets) {
      const { unresolved } = targets;
      return { outcome: 'defect', code: 'DATA_PARSE_ERROR', message: placedMessage(`The alias *${unresolved.source} names no anchor before it`, offsetOf(unresolved), this.lines) };
    }
    const nodes: ExtractedDataNode[] = [];
    const conditions: ExtractedDataCondition[] = [];
    const ordinalOf = new Map<ValueNode, number>();
    let maxDepth = 0;
    const stack: PendingNode[] = [{
      slot: root, parent: null, pointer: '', key: null, idx: null, depth: 1, shadowed: false,
      offset: root === null ? 0 : offsetOf(root), repeatIn: null, nonStringKey: false, expansion: null,
    }];
    while (stack.length > 0) {
      const pending = stack.pop() as PendingNode;
      const { node, expansion } = this.resolve(pending, nodes.length, targets.targets, ordinalOf);
      const numbered = this.numbered({ doc, pending, node }, nodes.length, expansion);
      if ('outcome' in numbered) return numbered;
      const { row } = numbered;
      const container = isMap(node) || isSeq(node);
      if (container && row.depth > this.limits.outputDepth) return { outcome: 'breach', limit: 'outputDepth', found: row.depth };
      if (container) maxDepth = Math.max(maxDepth, row.depth);
      nodes.push(row);
      pushNodeConditions(conditions, row, pending);
      const breach = this.producedBreach(row, nodes.length + conditions.length);
      if (breach !== undefined) return breach;
      const children = childrenOf(pending, node, row.ordinal, expansion, { text: this.text, targets: targets.targets });
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index] as PendingNode);
    }
    this.heads.push({ doc, rootType: (nodes[0] as ExtractedDataNode).type, nodeCount: nodes.length, maxDepth });
    appendAll(this.nodes, nodes);
    appendAll(this.conditions, conditions);
    return undefined;
  }

  /**
   * A node's row, or why it has none: a lone surrogate in its key or string, or a scalar no row holds.
   *
   * @param node - The node, its document and its parent's decisions
   * @param ordinal - Its pre-order number
   * @param expansion - The expansion its row is part of
   * @returns The row, or the defect
   */
  private numbered(
    { doc, pending, node }: Omit<TypedNode, 'scalar'>,
    ordinal: number,
    expansion: Expansion | null,
  ): { row: ExtractedDataNode } | DataExtraction {
    const lone = loneSurrogateIn(pending, node);
    if (lone !== undefined) return loneSurrogateDefect(lone, this.lines);
    const scalar = typed(node);
    if (scalar === undefined) {
      const resolved = typeof (node as Scalar).value;
      return { outcome: 'defect', code: 'DATA_PARSE_ERROR', message: placedMessage(`The scalar resolves to a ${resolved}, which no data row holds`, pending.offset, this.lines) };
    }
    return { row: this.nodeRow({ doc, pending, node, scalar }, ordinal, expansion) };
  }

  /**
   * Count one more row against `outputRows` and `outputBytes`.
   *
   * @param row - The row just produced
   * @param documentRows - The current document's node and condition rows so far, the row included
   * @returns The cap the rows so far pass, if any
   */
  private producedBreach(row: ExtractedDataNode, documentRows: number): DataExtraction | undefined {
    const produced = 1 + this.documentCount + this.nodes.length + this.conditions.length + documentRows;
    if (produced > this.limits.outputRows) return { outcome: 'breach', limit: 'outputRows', found: produced };
    this.bytes += rowBytesFloor(row);
    if (this.bytes > this.limits.outputBytes) return { outcome: 'breach', limit: 'outputBytes', found: this.bytes };
    return undefined;
  }

  /**
   * The node a pending slot stands for, and the expansion its row is part of:
   * an alias outside any expansion starts one; an original node is recorded
   * as the row its anchor's aliases copy.
   */
  private resolve(
    pending: PendingNode,
    ordinal: number,
    targets: AliasTargets,
    ordinalOf: Map<ValueNode, number>,
  ): { node: ValueNode | null; expansion: Expansion | null } {
    const { slot } = pending;
    if (isAlias(slot)) {
      const node = targets.get(slot) as ValueNode;
      return { node, expansion: pending.expansion ?? { anchor: ordinalOf.get(node) ?? null, start: ordinal } };
    }
    if (slot !== null && pending.expansion === null && !ordinalOf.has(slot)) ordinalOf.set(slot, ordinal);
    return { node: slot, expansion: pending.expansion };
  }

  private nodeRow({ doc, pending, node, scalar }: TypedNode, ordinal: number, expansion: Expansion | null): ExtractedDataNode {
    const { type, value } = scalar;
    const lexeme = type === 'number' ? (node as Scalar).source ?? String(value) : null;
    const copied = expansion?.anchor ?? null;
    return {
      doc,
      ordinal,
      parent: pending.parent,
      pointer: pending.pointer,
      key: pending.key,
      idx: pending.idx,
      depth: pending.depth,
      type,
      value,
      lexeme,
      childCount: isMap(node) || isSeq(node) ? node.items.length : 0,
      tag: node?.tag ?? null,
      aliasOf: copied === null || expansion === null ? null : copied + (ordinal - expansion.start),
      shadowed: pending.shadowed,
      ...positionOf(pending.offset, this.lines),
    };
  }
}

/** A node's row type and scalar value. */
interface TypedScalar {
  readonly type: DataNodeType;
  readonly value: string | number | boolean | null;
}

/** What a node's row is made from: its document, its parent's decisions, the node and its typed value. */
interface TypedNode {
  readonly doc: number;
  readonly pending: PendingNode;
  readonly node: ValueNode | null;
  readonly scalar: TypedScalar;
}

/**
 * @param node - A composed node, or null for an absent value
 * @returns Its row type and scalar value (a number's `-0` as `0`; null for null and containers);
 *   undefined for a scalar no row holds
 */
function typed(node: ValueNode | null): TypedScalar | undefined {
  if (isMap(node)) return { type: 'object', value: null };
  if (isSeq(node)) return { type: 'array', value: null };
  const value: unknown = node?.value ?? null;
  if (value === null) return { type: 'null', value: null };
  if (typeof value === 'number') return { type: 'number', value: value === 0 ? 0 : value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  // With the 1.1 tags off, the core schema resolves every other scalar to a string (an unresolved tag keeps its source).
  if (typeof value === 'string') return { type: 'string', value };
  return undefined;
}

/**
 * The JSON of a row with every column at its shortest: each string empty, each number and each
 * nullable column a one-digit number, the shortest type name. A row's JSON is never shorter.
 */
const SHORTEST_ROW_BYTES = Buffer.byteLength(JSON.stringify({
  doc: 0, ordinal: 0, parent: 0, pointer: '', key: '', idx: 0, depth: 0, type: 'null', value: 0, lexeme: '', childCount: 0,
  tag: '', aliasOf: 0, shadowed: true, line: 0, column: 0,
} satisfies Record<keyof ExtractedDataNode, unknown>));

/**
 * A floor of one row's JSON bytes: the shortest row, plus each string column's length (a UTF-16
 * code unit is never fewer UTF-8 bytes, and escaping only lengthens). Never above the bytes
 * `factsOutputBreach` counts for the row, so a breach of the floor is a breach of the row set.
 *
 * @param row - A node row
 * @returns The floor
 */
function rowBytesFloor(row: ExtractedDataNode): number {
  const value = typeof row.value === 'string' ? row.value.length : 0;
  return SHORTEST_ROW_BYTES + row.pointer.length + (row.key?.length ?? 0) + value + (row.lexeme?.length ?? 0) + (row.tag?.length ?? 0);
}

/**
 * @param node - A composed node
 * @returns Where it starts in the text (after any tag or anchor)
 */
function offsetOf(node: YamlNode): number {
  return node.range?.[0] ?? 0;
}

/**
 * Resolve every alias of one document to the node its anchor names: the last
 * node anchored so before the alias in document order (keys included, an
 * anchor before its own descendants), as the library's `Alias.resolve` does,
 * in one pass by an explicit stack rather than one pass per alias.
 *
 * @param root - The document's root
 * @returns Each alias's target, or the first alias that names no anchor before it
 */
function resolveAliases(root: Slot): { targets: AliasTargets } | { unresolved: Alias } {
  const targets = new Map<Alias, ValueNode>();
  const anchors = new Map<string, ValueNode>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isAlias(node)) {
      const target = anchors.get(node.source);
      if (target === undefined) return { unresolved: node };
      targets.set(node, target);
    } else if (isScalar(node) || isMap(node) || isSeq(node)) {
      if (node.anchor !== undefined) anchors.set(node.anchor, node);
      const children = childNodesOf(node);
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    }
  }
  return { targets };
}

/**
 * @param node - A composed node
 * @returns Every node directly under it, in document order: a map's keys and values, a sequence's items
 */
function childNodesOf(node: ValueNode): unknown[] {
  if (isMap(node)) return (node.items as Pair[]).flatMap((pair) => [pair.key, pair.value]);
  return isSeq(node) ? node.items : [];
}

/**
 * @param pending - A node and its parent's decisions
 * @param node - The node it resolved to
 * @returns Where its key, or its string value, holds a lone surrogate; undefined when neither does
 */
function loneSurrogateIn(pending: PendingNode, node: ValueNode | null): LoneSurrogate | undefined {
  if (pending.key !== null && !pending.key.isWellFormed()) return { inKey: true, offset: pending.offset };
  if (isScalar(node) && typeof node.value === 'string' && !node.value.isWellFormed()) return { inKey: false, offset: offsetOf(node) };
  return undefined;
}

/** A member's key as a row keys it. */
interface MemberKey {
  readonly key: string;
  readonly nonString: boolean;
  /** Where the member is placed: its key, or its value when it has no key node. */
  readonly offset: number;
}

/** What reading a member's key needs: the document and its aliases' targets. */
interface KeyContext {
  readonly text: string;
  readonly targets: AliasTargets;
}

/**
 * @param pair - A map's member
 * @param context - The document and its aliases' targets
 * @returns Its key: a string key's value (an alias to a string scalar reads as that string), any
 *   other key's trimmed source text
 */
function memberKey(pair: Pair, { text, targets }: KeyContext): MemberKey {
  const keyNode = pair.key as Slot;
  const valueNode = pair.value as Slot;
  const placed = keyNode ?? valueNode;
  const offset = placed === null ? 0 : offsetOf(placed);
  const resolved = isAlias(keyNode) ? targets.get(keyNode) : keyNode;
  if (isScalar(resolved) && typeof resolved.value === 'string') return { key: resolved.value, nonString: false, offset };
  const range = keyNode?.range;
  const source = range === undefined || range === null ? '' : text.slice(range[0], range[1]).trim();
  return { key: source, nonString: true, offset };
}

/**
 * A container's children, in document order, with what this container decides
 * about each: pointer, key or index, depth, place, and whether a later sibling
 * with the same key shadows it.
 *
 * @param pending - The container (or a scalar, which has none)
 * @param node - The node it resolved to
 * @param ordinal - Its pre-order number, the children's parent
 * @param expansion - The expansion its row is part of, which its children share
 * @param context - The document and its aliases' targets, to read member keys
 * @returns Its children
 */
function childrenOf(pending: PendingNode, node: ValueNode | null, ordinal: number, expansion: Expansion | null, context: KeyContext): PendingNode[] {
  const below = { parent: ordinal, depth: pending.depth + 1, expansion };
  if (isSeq(node)) {
    return node.items.map((item, idx) => {
      const slot = item as Slot;
      return {
        ...below,
        slot,
        pointer: `${pending.pointer}/${String(idx)}`,
        key: null,
        idx,
        shadowed: pending.shadowed,
        offset: slot === null ? pending.offset : offsetOf(slot),
        repeatIn: null,
        nonStringKey: false,
      };
    });
  }
  if (!isMap(node)) return [];
  const pairs = node.items as Pair[];
  const keys = pairs.map((pair) => memberKey(pair, context));
  const order = memberOrder(keys.map((member) => member.key));
  return pairs.map((pair, index) => {
    const member = keys[index] as MemberKey;
    const { shadowed, repeat } = order[index] as (typeof order)[number];
    return {
      ...below,
      slot: pair.value as Slot,
      pointer: `${pending.pointer}/${encodeJsonPointerSegment(member.key)}`,
      key: member.key,
      idx: null,
      shadowed: pending.shadowed || shadowed,
      offset: member.offset,
      repeatIn: repeat ? pending.pointer : null,
      nonStringKey: member.nonString,
    };
  });
}

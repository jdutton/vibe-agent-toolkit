/**
 * The decoded frontmatter mapping, as a string the parent can rebuild without
 * decoding any YAML.
 *
 * ## Why this exists
 *
 * YAML is decoded once, in the parse worker, under that worker's limits (ADR
 * I8): a deeply nested block recurses through `yaml`'s composer, and on the
 * main thread a 1,000-level `a: [[[…]]]` already overflows the stack. So the
 * parent never calls `yaml.parse` on frontmatter — not after a worker parse
 * (`attachContent` in `parse-pool.ts`) and not on a parse-cache hit
 * (`rehydrate` in `parse-cache.ts`). Both rebuild the mapping from this
 * encoding instead, which the worker produced and the cache stores.
 *
 * ## Why a tagged table, and not the object itself
 *
 * `yaml` hands back values neither JSON nor the structured clone between
 * threads carries faithfully: `.inf`, `.nan` and `-0` (JSON writes `null` and
 * `0`), `!!binary` (a `Buffer` arrives as a `Uint8Array`), `!!set`, `!!omap`
 * and `!!timestamp` (JSON flattens them), and shared or cyclic anchors (JSON
 * throws on a cycle). The encoding names each of those with a tag.
 *
 * It is also FLAT: every object becomes one entry in a table, and a container
 * points at its children by index. The encoded JSON is therefore never more
 * than three levels deep however deep the frontmatter is, so no
 * `JSON.stringify`, `JSON.parse`, structured clone or recursive walk on the
 * main thread meets the document's depth. Both directions are loops.
 *
 * ## The format
 *
 * `[node0, node1, …]`; node 0 is the mapping. A child slot holds a JSON
 * string, boolean, `null` or finite number inline, or `[i]` — a reference to
 * node `i`. Nodes are `[tag, …]`:
 *
 * | Tag | Value | Rest |
 * |---|---|---|
 * | `o` | plain object | key, child, key, child, … |
 * | `a` | array | child, … |
 * | `m` | `Map` | key child, value child, … |
 * | `s` | `Set` | child, … |
 * | `n` | non-finite number or `-0` | `'NaN'`, `'Infinity'`, `'-Infinity'` or `'-0'` |
 * | `b` | `Buffer` | base64 |
 * | `d` | `Date` | `String(getTime())` |
 * | `g` | `bigint` | decimal string |
 * | `u` | `undefined` | — |
 */

import { VatError } from '@vibe-agent-toolkit/utils';

/** The `code` a malformed encoding is refused with. */
export const FRONTMATTER_VALUE_MALFORMED = 'FRONTMATTER_VALUE_MALFORMED';

/** One child slot: an inline JSON scalar, or a one-element reference to a node. */
type Slot = string | number | boolean | null | [number];

/** One table entry: a tag, then its contents. */
type EncodedNode = [string, ...unknown[]];

/** Non-finite numbers and `-0`, by the spelling the encoding stores. */
const SPECIAL_NUMBERS: ReadonlyMap<string, number> = new Map([
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['-0', -0],
]);

/**
 * Encode a decoded frontmatter mapping.
 *
 * @param mapping - What `yaml` decoded the block to
 * @returns The encoding, a JSON string
 * @throws If the root is not a plain mapping (see {@link isPlainMapping}), or the
 *   mapping holds a value `yaml` never produces (a function, a symbol, a class instance)
 */
export function encodeFrontmatterValue(mapping: Record<string, unknown>): string {
  // The decode refuses any other root, so an encoding written past this line
  // would be one the parent cannot rebuild: refused here, in the worker.
  if (!isPlainMapping(mapping)) {
    throw new VatError(FRONTMATTER_VALUE_MALFORMED, `A frontmatter root must be a plain mapping, not ${describeType(mapping)}.`);
  }
  const nodes: EncodedNode[] = [];
  const indexOf = new Map<unknown, number>();
  const pending: unknown[] = [];

  /** The node a non-scalar value is, numbered on first sight and queued to be encoded. */
  const reference = (value: unknown): [number] => {
    let index = indexOf.get(value);
    if (index === undefined) {
      index = nodes.length;
      nodes.push(['u']);
      indexOf.set(value, index);
      pending.push(value);
    }
    return [index];
  };
  const slot = (value: unknown): Slot => (isInlineScalar(value) ? value : reference(value));

  reference(mapping);
  // `pending` grows as nodes are encoded; an array iterator reads the length on
  // every step, so this walks every queued value, breadth first, with no recursion.
  for (const value of pending) {
    nodes[indexOf.get(value) ?? 0] = encodeNode(value, slot);
  }
  return JSON.stringify(nodes);
}

/**
 * @param value - Any value
 * @returns True for what JSON carries exactly: a string, boolean, `null` or finite non-negative-zero number
 */
function isInlineScalar(value: unknown): value is string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0);
}

/**
 * One value's table entry. Its children become slots, queued by `slot`.
 *
 * @param value - A value that is not an inline scalar
 * @param slot - Turns a child into a slot
 * @returns The node
 */
function encodeNode(value: unknown, slot: (child: unknown) => Slot): EncodedNode {
  if (typeof value === 'number') return ['n', Object.is(value, -0) ? '-0' : String(value)];
  if (typeof value === 'bigint') return ['g', value.toString()];
  if (value === undefined) return ['u'];
  if (value instanceof Uint8Array) return ['b', Buffer.from(value).toString('base64')];
  if (value instanceof Date) return ['d', String(value.getTime())];
  const node = containerNode(value, slot);
  if (node !== undefined) return node;
  throw new VatError(FRONTMATTER_VALUE_MALFORMED, `Cannot encode a frontmatter value of type ${describeType(value)}.`);
}

/**
 * A container's table entry, built by appending one slot at a time: never a
 * spread, `apply` or `flatMap` whose argument count or intermediate array grows
 * with the container, so a list of any length encodes.
 *
 * @param value - A value that is not an inline scalar or a leaf
 * @param slot - Turns a child into a slot
 * @returns The node, or undefined when the value is no container
 */
function containerNode(value: unknown, slot: (child: unknown) => Slot): EncodedNode | undefined {
  if (Array.isArray(value)) return appendSlots(['a'], value as unknown[], slot);
  if (value instanceof Set) return appendSlots(['s'], value as Set<unknown>, slot);
  if (value instanceof Map) {
    const node: EncodedNode = ['m'];
    for (const [key, child] of value as Map<unknown, unknown>) node.push(slot(key), slot(child));
    return node;
  }
  if (isPlainMapping(value)) {
    const node: EncodedNode = ['o'];
    for (const key of Object.keys(value)) node.push(key, slot(value[key]));
    return node;
  }
  return undefined;
}

/**
 * @param node - A container node holding only its tag
 * @param children - Its children, in order
 * @param slot - Turns a child into a slot
 * @returns The node, one slot appended per child
 */
function appendSlots(node: EncodedNode, children: Iterable<unknown>, slot: (child: unknown) => Slot): EncodedNode {
  for (const child of children) node.push(slot(child));
  return node;
}

/**
 * Whether a value is a plain mapping: an object whose prototype is
 * `Object.prototype` or `null`. The one statement of what a frontmatter root may
 * be — `parseFrontmatterSource` admits nothing else as `frontmatter`, and the
 * encoding refuses any other root.
 *
 * @param value - Any value
 * @returns True for an object whose prototype is `Object.prototype` or `null`
 */
export function isPlainMapping(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param value - Any value
 * @returns Its constructor's name, or its `typeof`
 */
function describeType(value: unknown): string {
  if (typeof value !== 'object' || value === null) return typeof value;
  const prototype: unknown = Object.getPrototypeOf(value);
  const name: unknown = (prototype as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return typeof name === 'string' ? name : 'object';
}

/**
 * Rebuild a decoded frontmatter mapping from its encoding.
 *
 * Two passes over the flat table: every node's shell first, so a reference to
 * any node — an anchor shared, or a cycle back to an ancestor — resolves, then
 * every container's contents.
 *
 * @param encoded - What {@link encodeFrontmatterValue} returned
 * @returns The mapping, equal to what `yaml` decoded
 * @throws A `VatError` coded `FRONTMATTER_VALUE_MALFORMED` for anything it did not write
 */
export function decodeFrontmatterValue(encoded: string): Record<string, unknown> {
  const parsed = parseTable(encoded);
  if (!Array.isArray(parsed) || parsed.length === 0) throw malformed('not a node table');
  const nodes = parsed.map((node) => requireNode(node));
  const shells = nodes.map((node) => shellFor(node));
  const resolve = (child: unknown): unknown => resolveSlot(child, shells);
  for (const [index, node] of nodes.entries()) fill(node, shells[index], resolve);

  const root = shells[0];
  if (nodes[0]?.[0] !== 'o' || !isPlainMapping(root)) throw malformed('the first node is not a mapping');
  return root;
}

/**
 * @param encoded - An encoding, as stored or sent
 * @returns Its JSON value
 * @throws `FRONTMATTER_VALUE_MALFORMED` when it is not JSON at all
 */
function parseTable(encoded: string): unknown {
  try {
    return JSON.parse(encoded);
  } catch (error) {
    // `JSON.parse` throws nothing but a SyntaxError for its input.
    if (!(error instanceof SyntaxError)) throw error;
    throw malformed('not JSON');
  }
}

/**
 * @param node - One table entry as parsed
 * @returns It, checked to be a tagged array
 */
function requireNode(node: unknown): EncodedNode {
  if (!Array.isArray(node) || typeof node[0] !== 'string') throw malformed('a node is not a tagged array');
  return node as EncodedNode;
}

/**
 * A node's value, empty if it is a container.
 *
 * @param node - One table entry
 * @returns The leaf value, or the container to fill
 */
function shellFor(node: EncodedNode): unknown {
  const [tag, payload] = node;
  switch (tag) {
    case 'o': {
      return {};
    }
    case 'a': {
      return [];
    }
    case 'm': {
      return new Map();
    }
    case 's': {
      return new Set();
    }
    case 'u': {
      return undefined;
    }
    default: {
      return leafFor(tag, payload);
    }
  }
}

/**
 * @param tag - A leaf tag
 * @param payload - Its one stored string
 * @returns The leaf value
 */
function leafFor(tag: string, payload: unknown): unknown {
  if (typeof payload !== 'string') throw malformed(`a "${tag}" node has no string payload`);
  if (tag === 'n') {
    const value = SPECIAL_NUMBERS.get(payload);
    if (value === undefined) throw malformed(`"${payload}" is not a special number`);
    return value;
  }
  if (tag === 'b') return Buffer.from(payload, 'base64');
  if (tag === 'd') return new Date(Number(payload));
  if (tag === 'g') return BigInt(payload);
  throw malformed(`unknown tag "${tag}"`);
}

/**
 * Put a container node's children into its shell.
 *
 * @param node - One table entry
 * @param shell - Its shell
 * @param resolve - Turns a slot into a value
 */
function fill(node: EncodedNode, shell: unknown, resolve: (child: unknown) => unknown): void {
  const tag = node[0];
  // An index loop from 1, never `[tag, ...rest]` or `push(...children)`: a
  // spread's arguments live on the stack, and a long enough list overflows it
  // on whatever thread decodes (about 130,000 on Node's default main stack).
  if (tag === 'a') {
    const array = shell as unknown[];
    for (let index = 1; index < node.length; index += 1) array.push(resolve(node[index]));
  }
  if (tag === 's') {
    const set = shell as Set<unknown>;
    for (let index = 1; index < node.length; index += 1) set.add(resolve(node[index]));
  }
  if (tag === 'm' || tag === 'o') fillPairs(tag, node, shell, resolve);
}

/**
 * Put a mapping's or a `Map`'s pairs into its shell.
 *
 * A `__proto__` key becomes an own property, as `yaml` makes it, never the
 * object's prototype.
 *
 * @param tag - `o` or `m`
 * @param node - The tag, then key, child, key, child, …
 * @param shell - The object or `Map`
 * @param resolve - Turns a slot into a value
 */
function fillPairs(tag: string, node: EncodedNode, shell: unknown, resolve: (child: unknown) => unknown): void {
  if ((node.length - 1) % 2 !== 0) throw malformed(`a "${tag}" node has an unpaired key`);
  for (let index = 1; index < node.length; index += 2) {
    const value = resolve(node[index + 1]);
    if (tag === 'm') {
      (shell as Map<unknown, unknown>).set(resolve(node[index]), value);
      continue;
    }
    const key = node[index];
    if (typeof key !== 'string') throw malformed('a mapping key is not a string');
    Object.defineProperty(shell, key, { value, writable: true, enumerable: true, configurable: true });
  }
}

/**
 * @param child - A slot as parsed
 * @param shells - Every node's value
 * @returns The inline scalar, or the node it references
 */
function resolveSlot(child: unknown, shells: unknown[]): unknown {
  if (!Array.isArray(child)) {
    if (child === null || ['string', 'number', 'boolean'].includes(typeof child)) return child;
    throw malformed('a slot is neither a scalar nor a reference');
  }
  const [index] = child as unknown[];
  if (child.length !== 1 || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= shells.length) {
    throw malformed('a reference names no node');
  }
  return shells[index];
}

/**
 * @param reason - What was wrong
 * @returns The refusal
 */
function malformed(reason: string): VatError {
  return new VatError(FRONTMATTER_VALUE_MALFORMED, `Malformed decoded-frontmatter encoding: ${reason}.`);
}

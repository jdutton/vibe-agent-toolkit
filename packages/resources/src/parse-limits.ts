/**
 * The limits every parse job runs under, and the one error a breach becomes.
 *
 * ## Why every parse runs bounded
 *
 * The fact-extractors ADR's I8 ("every run ends with an answer or a refusal
 * within its limit") cannot hold over a parser running on the thread that owns
 * the run: a synchronous parser that never returns cannot be interrupted from
 * the same thread, and a stack or heap it exhausts takes the whole process with
 * it. So every parse runs in a worker of `parse-pool.ts`, and that pool is the
 * only place these limits are enforced. Measured on the shipped markdown parser:
 * a 1,000-level nested list parses in 9.3 s in a worker (a lab arm, recorded in
 * `fact-extractors-limits.md`), so parse time grows past any fixed budget with
 * depth; 10,000 nested `>` overflow the main thread's stack (a worker's 4 MiB
 * parses them in 0.6 s).
 *
 * ## Why a breach persists nothing (I6)
 *
 * Time, heap and stack outcomes depend on the machine and its load, not on the
 * bytes, so a breach is filed nowhere: no parse-cache entry, no stored failure.
 * The next run re-attempts the pair. Output and input caps ARE functions of the
 * bytes, but storing them under their limit is Deferred in the ADR, so for now
 * they are per-run too — one rule, no second lane. The cost, a key-determined
 * breach re-attempted every run, is the hazard register's accepted, counted row
 * `Cost: key-determined parse-limit breaches (output and input caps) re-attempted every run`
 * (`docs/architecture/fact-extractors-hazard-register.md`).
 *
 * ## Where the values come from
 *
 * The lab, never preference. The headroom rule and the measured record behind
 * each value are in `docs/architecture/fact-extractors-limits.md`; change a value
 * there and here together.
 */

import { VatError } from '@vibe-agent-toolkit/utils';

import type { ParseResult } from './link-parser.js';

/** The limits one parse job runs under. */
export interface ParseLimits {
  /** Wall-clock milliseconds a job may take, from dispatch to answer. */
  readonly timeMs: number;
  /** A worker's heap limit, in MiB, enforced by the pool's heap sampler (V8's own ceiling sits past it: `workerHeapCeilingMb`). */
  readonly heapMb: number;
  /** A worker's stack, in MiB (`resourceLimits.stackSizeMb`) — what bounds parser recursion. */
  readonly stackMb: number;
  /** Rows one job may produce, counted over every array the facts carry. */
  readonly outputRows: number;
  /** Bytes one job's facts may serialise to. */
  readonly outputBytes: number;
  /**
   * Levels of nesting the frontmatter may reach as JSON, the mapping itself
   * level 1. Never more than {@link STORE_JSON_DEPTH}: past it the stored value
   * makes every statement that reads the projection's frontmatter column throw.
   */
  readonly outputDepth: number;
  /** Raw bytes of one document a parser is handed at all. */
  readonly inputBytes: number;
}

/** Which limit a breach crossed. One name per {@link ParseLimits} field. */
export type ParseLimitName = keyof ParseLimits;

/**
 * The limits a parse runs under unless a caller names tighter ones.
 *
 * Derived from the lab record in `docs/architecture/fact-extractors-limits.md`:
 * a limit the lab observes is the largest value seen on any measured corpus,
 * times ten, rounded up to a power of two in its unit. A limit the lab cannot
 * yet observe per job (`timeMs`, `heapMb`) keeps a bound the record justifies
 * another way — `timeMs` covers the slowest realistic shape found (a
 * 1,000-level nested list, 9.3 s) plus a cold worker's parser load, with
 * headroom for a loaded machine. Named for what they bound, never a version.
 */
const DEFAULT_PARSE_LIMITS: ParseLimits = {
  timeMs: 30_000,
  heapMb: 1024,
  stackMb: 4,
  outputRows: 16_384,
  outputBytes: 4 * 1024 * 1024,
  outputDepth: 1000,
  inputBytes: 8 * 1024 * 1024,
};

/**
 * The deepest JSON SQLite's JSON functions read (its `JSON_MAX_DEPTH`): one
 * level deeper and `json_extract` throws "malformed JSON" for the whole
 * statement, so every other row's answer is lost with it. Measured on Node
 * 26's `node:sqlite`: 1,000 nested containers read, 1,001 refuse. The store's
 * own ceiling, not a tuned value: `outputDepth` may be set tighter, never looser.
 */
const STORE_JSON_DEPTH = 1000;

/** How each limit is spelled to a user, so a refusal names the bound in its own unit. */
const LIMIT_UNITS: Readonly<Record<ParseLimitName, (value: number) => string>> = {
  timeMs: (value) => `${value} ms wall clock`,
  heapMb: (value) => `${value} MiB heap`,
  stackMb: (value) => `${value} MiB stack`,
  outputRows: (value) => `${value} output rows`,
  outputBytes: (value) => `${value} output bytes`,
  outputDepth: (value) => `${value} levels of nesting`,
  inputBytes: (value) => `${value} input bytes`,
};

/** The `code` every {@link ParseLimitError} carries, and the one thing a classifier reads. */
const PARSE_LIMIT_EXCEEDED = 'PARSE_LIMIT_EXCEEDED';

/**
 * A parse job was stopped at one of its limits.
 *
 * Classified by {@link isParseLimitError}, which reads `code` — the error
 * crosses a thread boundary as plain data and is rebuilt on this side, so
 * `instanceof` alone would miss the rebuilt one.
 */
export class ParseLimitError extends VatError {
  readonly limit: ParseLimitName;
  /** The bound in its own unit, e.g. `10000 ms wall clock`. */
  readonly bound: string;

  /**
   * @param limit - The limit crossed
   * @param value - Its value in force
   * @param found - What the document measured against it, when known (an
   *   output breach), so the refusal says how far past the limit it was
   * @param bound - The bound as spelled, overriding the default spelling
   */
  constructor(limit: ParseLimitName, value: number, found?: number, bound: string = describeBound(limit, value, found)) {
    super(PARSE_LIMIT_EXCEEDED, `The parse was stopped at its ${limit} limit (${bound}).`);
    this.limit = limit;
    this.bound = bound;
  }

  /**
   * A heap breach the pool's sampler stopped, naming the limit that actually
   * applied.
   *
   * @param appliedMb - The heap limit the pool enforced on the worker — see
   *   {@link heapBounds}
   * @param configuredMb - The `heapMb` this pool was given
   * @returns The breach, saying so when a process-wide flag lowered the limit
   */
  static heap(appliedMb: number, configuredMb: number): ParseLimitError {
    const bound = LIMIT_UNITS.heapMb(appliedMb);
    return new ParseLimitError(
      'heapMb',
      appliedMb,
      undefined,
      appliedMb < configuredMb
        ? `${bound}, lowered from ${String(configuredMb)} MiB by a process-wide --max-old-space-size`
        : bound,
    );
  }

  /**
   * A heap breach V8 stopped at its OWN ceiling, before the pool's sampler did
   * (the parent was blocked past the stall window, so a sample landed late or
   * never). It names that ceiling — as the last sample to land read it —
   * never the sampler's bound, which did not stop it.
   *
   * @param bounds - What the last sample to land read ({@link heapBounds}), or
   *   `undefined` when none landed: then the ceiling is unknown, since a
   *   process-wide `--max-old-space-size` overrides it in either direction
   * @param configuredMb - The `heapMb` this pool was given
   * @returns The breach
   */
  static heapCeiling(bounds: HeapBounds | undefined, configuredMb: number): ParseLimitError {
    if (bounds === undefined) {
      return new ParseLimitError(
        'heapMb',
        workerHeapCeilingMb(configuredMb),
        undefined,
        `V8's own heap ceiling, reached before the pool's heap sampler read it: ${LIMIT_UNITS.heapMb(workerHeapCeilingMb(configuredMb))}, unless a process-wide --max-old-space-size set it instead`,
      );
    }
    return new ParseLimitError(
      'heapMb',
      bounds.ceilingMb,
      undefined,
      `V8's own heap ceiling, ${LIMIT_UNITS.heapMb(bounds.ceilingMb)} — above the ${String(bounds.appliedMb)} MiB the pool's heap sampler enforces, reached before the sampler read the heap past it`,
    );
  }
}

/**
 * A limit's bound in its own unit, and what the document measured when known.
 *
 * @param limit - The limit
 * @param value - Its value in force
 * @param found - What the document measured; `Infinity` for a cyclic frontmatter's depth
 * @returns e.g. `1000 levels of nesting; this document nests 2000`
 */
function describeBound(limit: ParseLimitName, value: number, found: number | undefined): string {
  const bound = LIMIT_UNITS[limit](value);
  if (found === undefined) return bound;
  if (limit !== 'outputDepth') return `${bound}; this document has ${String(found)}`;
  return Number.isFinite(found)
    ? `${bound}; this document nests ${String(found)}`
    : `${bound}; this document's frontmatter refers back into itself (a cyclic anchor), so it nests without end`;
}

/**
 * Whether a thrown value is a parse stopped at a limit.
 *
 * @param error - Anything a parse threw
 * @returns True for a {@link ParseLimitError}, or anything wearing its code and limit
 */
export function isParseLimitError(error: unknown): error is ParseLimitError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PARSE_LIMIT_EXCEEDED &&
    typeof (error as { limit?: unknown }).limit === 'string' &&
    typeof (error as { bound?: unknown }).bound === 'string'
  );
}

/**
 * The limits in force: the defaults, with whatever a caller named over them.
 *
 * A named value that is not a positive finite number is refused rather than
 * clamped — `Math.max(1, NaN)` is `NaN`, and a `NaN` bound compares false
 * against everything, which deletes the limit instead of setting it.
 *
 * @param named - Limits a caller (a test, a measurement arm) chose
 * @returns Every limit, each a positive finite number
 * @throws If a named limit is not a positive finite number
 */
export function resolveParseLimits(named: Partial<ParseLimits> | undefined): ParseLimits {
  const resolved: ParseLimits = { ...DEFAULT_PARSE_LIMITS, ...named };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Parse limit ${name} must be a positive finite number; got ${String(value)}.`);
    }
  }
  if (resolved.outputDepth > STORE_JSON_DEPTH) {
    throw new Error(
      `Parse limit outputDepth may not exceed ${String(STORE_JSON_DEPTH)}, the deepest JSON the projection store reads; got ${String(resolved.outputDepth)}.`,
    );
  }
  return resolved;
}

/**
 * How many rows a job's facts hold: the length of every array among them,
 * nested ones included.
 *
 * Every array, not a named list of fields, so a field added to the facts is
 * counted without anyone remembering to — and every NESTED array, because a
 * heading tree carries its rows in `children`: one `#` over 20,000 `##` is one
 * top-level heading and 20,001 rows. A loop over an explicit stack, never a
 * recursion, so the count cannot overflow on deep facts.
 *
 * @param facts - What a parser produced, minus the content
 * @returns The total number of array elements, at every depth
 */
export function countOutputRows(facts: object): number {
  let rows = 0;
  const pending: unknown[] = Object.values(facts);
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      rows += value.length;
      for (const element of value as unknown[]) pending.push(element);
    } else if (typeof value === 'object' && value !== null) {
      for (const field of Object.values(value)) pending.push(field);
    }
  }
  return rows;
}

/**
 * Rows and bytes of the JSON the store writes for a decoded value (the
 * projection's `json` column is its `JSON.stringify`), every alias written out
 * in full — and every `!!set` member and `!!omap` entry, which the codec
 * carries to the parent though `JSON.stringify` writes them as `{}`.
 */
interface ExpandedSize {
  /** Every array element, mapping entry, set member and ordered-map entry, at every depth. */
  readonly rows: number;
  /**
   * Bytes of that JSON, exactly — `Buffer.byteLength(JSON.stringify(value))`
   * for an acyclic value with no `Set` or `Map`; a `Set` counts as the array
   * of its members, a `Map` as the object of its entries, each key as its JSON.
   */
  readonly bytes: number;
  /**
   * How deep that JSON nests, a container itself level 1 (a scalar: 0; a
   * binary: 2, as `Buffer`'s JSON is `{"type", "data": [...]}`). `Infinity`
   * when it refers back into itself: no writer of JSON can write a cycle out.
   */
  readonly depth: number;
}

/**
 * A back-reference into a value still being sized (a cyclic anchor) costs this
 * many bytes: no consumer can write out a cycle in full, so it is counted as
 * the reference it is, never as an expansion that has no end.
 */
const CYCLE_REFERENCE_BYTES = 8;

/** One container being sized: its children, the next one to visit, and what it has added up so far. */
interface SizingFrame {
  readonly node: object;
  readonly children: readonly unknown[];
  next: number;
  rows: number;
  bytes: number;
  /** The deepest child's depth so far. */
  deepest: number;
}

/**
 * Whether a value is sized by its children: an array, a `Set` or `Map` (a
 * `!!set`, a `!!omap`, whose members the codec carries — see
 * {@link openFrame}), or an object with no `toJSON` of its own, which JSON
 * writes by its own enumerable keys (a bare `Uint8Array` its indices).
 * A `Buffer` (a `!!binary`) and a `Date` (a `!!timestamp`) write `toJSON`'s
 * answer instead, sized as leaves ({@link leafSize}).
 *
 * @param value - Any decoded value
 * @returns True for a value whose JSON is its children's
 */
function isContainer(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { toJSON?: unknown }).toJSON !== 'function';
}

/** `Buffer`'s JSON around its bytes: `{"type":"Buffer","data":[` … `]}`. */
const BUFFER_JSON_FRAME_BYTES = '{"type":"Buffer","data":[]}'.length;

/** How deep a binary's JSON nests: `Buffer`'s JSON is `{"type": …, "data": [ … ]}`. */
const BINARY_DEPTH = 2;

/**
 * @param byte - 0 to 255
 * @returns How many decimal digits JSON writes it with
 */
function decimalDigits(byte: number): number {
  if (byte < 10) return 1;
  return byte < 100 ? 2 : 3;
}

/**
 * A `Buffer`'s JSON, counted without building it: two entries and one row per
 * byte, each byte written as its decimal digits.
 *
 * @param binary - The decoded `!!binary`
 * @returns Its stored size
 */
function binarySize(binary: Buffer): ExpandedSize {
  let digits = 0;
  for (const byte of binary) digits += decimalDigits(byte);
  const commas = Math.max(0, binary.byteLength - 1);
  return { rows: 2 + binary.byteLength, bytes: BUFFER_JSON_FRAME_BYTES + digits + commas, depth: BINARY_DEPTH };
}

/**
 * A value JSON writes without children of its own: a scalar, or what its
 * `toJSON` answers (a `Date`'s ISO string).
 *
 * @param value - A value {@link isContainer} refuses
 * @returns Its stored size
 */
function leafSize(value: unknown): ExpandedSize {
  if (Buffer.isBuffer(value)) return binarySize(value);
  // `undefined` (no writer of YAML produces one) is `null` in an array.
  const json = JSON.stringify(value) ?? 'null';
  return { rows: 0, bytes: Buffer.byteLength(json), depth: 0 };
}

/**
 * A container's frame: its children, its own rows, and the bytes of its
 * brackets, separators and keys. No spread: a list of any length is read by
 * iteration.
 *
 * @param node - An array, or an object JSON writes by its own keys
 * @returns Its frame, before any child is sized
 */
function openFrame(node: object): SizingFrame {
  if (Array.isArray(node)) {
    return { node, children: node, next: 0, rows: node.length, bytes: 2 + Math.max(0, node.length - 1), deepest: 0 };
  }
  // `JSON.stringify` writes a `Set` or a `Map` as `{}`, but what the parent
  // rebuilds — and so what any consumer walks — carries every member
  // (`frontmatter-codec.ts`, nodes `s` and `m`). Counted as `{}`, a million
  // members cost one row and nesting or a cycle inside one went unseen.
  if (node instanceof Set) {
    const children: unknown[] = [];
    for (const member of node as Set<unknown>) children.push(member);
    return { node, children, next: 0, rows: children.length, bytes: 2 + Math.max(0, children.length - 1), deepest: 0 };
  }
  if (node instanceof Map) {
    // Each key is a child too: a `!!omap` key may be any value, a container included.
    const children: unknown[] = [];
    for (const [key, value] of node as Map<unknown, unknown>) children.push(key, value);
    const entries = (node as Map<unknown, unknown>).size;
    return { node, children, next: 0, rows: entries, bytes: 2 + entries + Math.max(0, entries - 1), deepest: 0 };
  }
  const children: unknown[] = [];
  const keys = Object.keys(node);
  // `{` `}`, a `:` per entry and a `,` between entries.
  let bytes = 2 + keys.length + Math.max(0, keys.length - 1);
  for (const key of keys) {
    children.push((node as Record<string, unknown>)[key]);
    bytes += Buffer.byteLength(JSON.stringify(key));
  }
  return { node, children, next: 0, rows: keys.length, bytes, deepest: 0 };
}

/**
 * Fold a sized child into its parent's frame.
 *
 * @param frame - The parent
 * @param size - The child's size
 */
function addSize(frame: SizingFrame, size: ExpandedSize): void {
  frame.rows += size.rows;
  frame.bytes += size.bytes;
  frame.deepest = Math.max(frame.deepest, size.depth);
}

/**
 * Add one child to its parent's frame: a leaf or an already-sized node at
 * once, a back-reference as a reference, and a node not yet seen by opening it.
 *
 * @param frame - The parent being sized
 * @param child - One of its children
 * @param sized - Every node sized so far
 * @param open - The nodes still being sized: the path from the root
 * @returns The child's own frame when it must be sized first
 */
function addChild(frame: SizingFrame, child: unknown, sized: ReadonlyMap<object, ExpandedSize>, open: Set<object>): SizingFrame | undefined {
  if (!isContainer(child)) {
    addSize(frame, leafSize(child));
    return undefined;
  }
  const known = sized.get(child);
  if (known !== undefined) {
    addSize(frame, known);
    return undefined;
  }
  if (open.has(child)) {
    frame.bytes += CYCLE_REFERENCE_BYTES;
    frame.deepest = Number.POSITIVE_INFINITY;
    return undefined;
  }
  open.add(child);
  return openFrame(child);
}

/**
 * The rows, bytes and depth of the JSON the store writes for a decoded
 * frontmatter value, every alias expanded: each use of an anchor counts the
 * anchor's full size, as `JSON.stringify` writes it and as a consumer walking
 * the value meets it. Exactly what the store writes — a `!!binary` is its
 * `Buffer` JSON (one row per byte, each byte its digits), never its base64's
 * length; a `!!set` is the list of its members and a `!!omap` the mapping of
 * its entries, as the codec carries them — never the `{}` JSON writes.
 *
 * The worker sends frontmatter in an encoding that writes a shared anchor
 * once (`frontmatter-codec.ts`), so a count over what crosses the wire would
 * let an anchor aliased a hundred times through at the price of one. This
 * counts what the parent rebuilds. Each node is sized once and its size reused
 * at every reference, so the cost is linear in the encoding, however large
 * the expansion; a cyclic back-reference counts {@link CYCLE_REFERENCE_BYTES}
 * and makes the depth unbounded. A loop over an explicit stack, never a recursion.
 *
 * @param root - What `yaml` decoded a frontmatter block to
 * @returns Its expanded rows, bytes and depth
 */
export function expandedSize(root: unknown): ExpandedSize {
  if (!isContainer(root)) return leafSize(root);
  const sized = new Map<object, ExpandedSize>();
  const open = new Set<object>([root]);
  const stack: SizingFrame[] = [openFrame(root)];
  let total: ExpandedSize = { rows: 0, bytes: 0, depth: 0 };
  while (stack.length > 0) {
    const frame = stack.at(-1) as SizingFrame;
    if (frame.next < frame.children.length) {
      const child = frame.children[frame.next];
      frame.next += 1;
      const opened = addChild(frame, child, sized, open);
      if (opened !== undefined) stack.push(opened);
      continue;
    }
    stack.pop();
    open.delete(frame.node);
    const size: ExpandedSize = { rows: frame.rows, bytes: frame.bytes, depth: frame.deepest + 1 };
    sized.set(frame.node, size);
    const parent = stack.at(-1);
    if (parent === undefined) {
      total = size;
    } else {
      addSize(parent, size);
    }
  }
  return total;
}

/** The caps on what a parse answers, as opposed to what running it costs. */
type OutputLimitName = 'outputDepth' | 'outputRows' | 'outputBytes';

/** An output cap a parse result breached, and what the result measured against it. */
interface OutputBreach {
  readonly limit: OutputLimitName;
  /** The depth, rows or bytes found; `Infinity` for a cyclic frontmatter's depth. */
  readonly found: number;
}

/**
 * The output cap a parse result breaches under `limits`, if any: depth, then
 * rows, then bytes — the ONE statement of that rule, applied by the worker before it
 * answers and by an in-process parse before it files an entry, so the shared
 * cache never holds facts the bounded route would refuse.
 *
 * Counted over the facts as stored and sent (the result minus `content`,
 * `sizeBytes` and the decoded `frontmatter`); bytes are their JSON. The
 * frontmatter is counted over its EXPANDED value, never its encoding: the
 * encoding writes a shared anchor once, so an anchor aliased 99 times would
 * cost one anchor's rows and bytes on the wire and a hundred in every consumer
 * that walks it. Each alias counts its target's full size ({@link expandedSize}).
 *
 * Depth is the frontmatter's as JSON, because that is how the projection stores
 * it: past `outputDepth` (never looser than SQLite's JSON depth) the stored
 * value makes every statement reading the column throw, every other row's
 * answer lost with it; a cyclic anchor nests without end and no writer of JSON
 * can write it at all. Refusing both here, in the worker, is the frontmatter
 * shape contract's depth half — the root half is `isPlainMapping` in
 * `frontmatter-source.ts` — so no consumer ever meets either.
 *
 * @param result - What a parser produced
 * @param limits - The caps in force
 * @returns The breached limit and what was found, or undefined
 */
export function outputBreach(
  result: ParseResult,
  limits: Pick<ParseLimits, OutputLimitName>,
): OutputBreach | undefined {
  const facts: Partial<ParseResult> = { ...result };
  delete facts.content;
  delete facts.sizeBytes;
  delete facts.frontmatter;
  return factsOutputBreach(facts, limits, result.frontmatter === undefined ? NOTHING_EXPANDED : expandedSize(result.frontmatter));
}

/** The size of no decoded value at all. */
const NOTHING_EXPANDED: ExpandedSize = { rows: 0, bytes: 0, depth: 0 };

/**
 * The output cap facts breach under `limits`: depth, then rows, then bytes —
 * the one rule {@link outputBreach} applies to a parse, and the worker applies
 * to any other job whose answer is plain JSON (a harness's memory facts).
 *
 * @param facts - The answer as sent, plain JSON
 * @param limits - The caps in force
 * @param expanded - The expanded size of a decoded value the facts carry
 *   beside themselves; nothing for an answer that carries none
 * @returns The breached limit and what was found, or undefined
 */
export function factsOutputBreach(
  facts: object,
  limits: Pick<ParseLimits, OutputLimitName>,
  expanded: ExpandedSize = NOTHING_EXPANDED,
): OutputBreach | undefined {
  if (expanded.depth > limits.outputDepth) return { limit: 'outputDepth', found: expanded.depth };
  const rows = countOutputRows(facts) + expanded.rows;
  if (rows > limits.outputRows) return { limit: 'outputRows', found: rows };
  const bytes = Buffer.byteLength(JSON.stringify(facts)) + expanded.bytes;
  if (bytes > limits.outputBytes) return { limit: 'outputBytes', found: bytes };
  return undefined;
}

/**
 * Whether an in-process parse's result may be filed in the shared cache: only
 * when the bounded route, under the default limits, would have admitted the
 * same bytes. Time, heap and stack are per run and never stored either way; the
 * input and output caps are key-determined, so an entry past them would turn a
 * bounded run's refusal into an admission that depends on what ran first.
 *
 * @param byteLength - Raw bytes of the document parsed
 * @param result - What the in-process parser produced
 * @returns True when a bounded parse of the same bytes would not be refused for its size
 */
export function storableUnderDefaultLimits(byteLength: number, result: ParseResult): boolean {
  return byteLength <= DEFAULT_PARSE_LIMITS.inputBytes && outputBreach(result, DEFAULT_PARSE_LIMITS) === undefined;
}

/**
 * The running engine's own stack-overflow message, captured once by
 * overflowing on purpose.
 *
 * V8 gives a stack overflow no code; a `RangeError` and its message are the
 * only signal. Rather than hard-code that prose, the worker asks the engine
 * what its overflow looks like and compares like with like, so an engine that
 * rewords the message still classifies correctly.
 */
let engineOverflowMessage: string | undefined;

function overflowMessage(): string {
  if (engineOverflowMessage !== undefined) return engineOverflowMessage;
  const descend = (depth: number): number => (depth < Number.MAX_SAFE_INTEGER ? descend(depth + 1) + 1 : depth);
  try {
    descend(0);
    engineOverflowMessage = '';
  } catch (error) {
    engineOverflowMessage = error instanceof RangeError ? error.message : '';
  }
  return engineOverflowMessage;
}

/**
 * Whether a thrown value is the engine running out of stack, in any shape a
 * parser reports it.
 *
 * Classified here, in one place, at the one boundary where a parser's own
 * recursion surfaces; nothing else in VAT classifies it. Two shapes:
 *
 * - the engine's own `RangeError`, thrown straight through;
 * - `yaml`'s wrapping of it. Its composer catches whatever a collection throws
 *   ("almost certainly here due to a stack overflow", its source says) and
 *   re-raises a `YAMLParseError` coded `RESOURCE_EXHAUSTION`. That catch is
 *   the code's only producer in `yaml`'s composer (its alias-count guard
 *   throws a `ReferenceError` instead), so the name and code identify it —
 *   never the message, and never `instanceof`, so this module loads no YAML
 *   library. Should anything else ever reach that catch, it is classified
 *   per-run, the direction that stores nothing.
 *
 * Either is a `stackMb` breach: a function of the stack the thread was given,
 * never of the bytes, so it is never stored and never a `frontmatterError`.
 *
 * @param error - Anything a parser threw
 * @returns True for a stack overflow
 */
export function isStackOverflow(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'YAMLParseError') return (error as { code?: unknown }).code === 'RESOURCE_EXHAUSTION';
  if (!(error instanceof RangeError)) return false;
  const signature = overflowMessage();
  return signature !== '' && error.message === signature;
}

/** The `code` every {@link ParseWorkerDiedError} carries. */
const PARSE_WORKER_DIED = 'PARSE_WORKER_DIED';

/** How a worker died: the exit code it left with, or the error it died of. */
type ParseWorkerDeath = { readonly exitCode: number } | { readonly cause: Error };

/**
 * The worker holding a job died without answering it.
 *
 * A per-run outcome, like a limit breach: a thread's death is a fact about this
 * run, never about the bytes, so it is never stored as a parse failure (ADR
 * I6). The run refuses that one file, and the next run parses it again.
 * Classified by {@link isParseWorkerDiedError}, which reads `code`.
 */
export class ParseWorkerDiedError extends VatError {
  /** The worker's exit code, when it exited rather than threw. */
  readonly exitCode: number | undefined;

  constructor(death: ParseWorkerDeath) {
    const exited = 'exitCode' in death;
    super(
      PARSE_WORKER_DIED,
      exited
        ? `VAT's parse worker exited unexpectedly with code ${String(death.exitCode)} while parsing.`
        : `VAT's parse worker died of ${describeDeath(death.cause)} while parsing.`,
      exited ? undefined : { cause: death.cause },
    );
    this.exitCode = exited ? death.exitCode : undefined;
  }
}

/**
 * @param cause - What a worker died of
 * @returns Its code (or name) and message
 */
function describeDeath(cause: Error): string {
  const code: unknown = (cause as { code?: unknown }).code;
  return `${typeof code === 'string' ? code : cause.name}: ${cause.message}`;
}

/**
 * Whether a thrown value is a worker that died holding the job.
 *
 * @param error - Anything a parse threw
 * @returns True for a {@link ParseWorkerDiedError}, or anything wearing its code
 */
export function isParseWorkerDiedError(error: unknown): error is ParseWorkerDiedError {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === PARSE_WORKER_DIED;
}

/** The `code` every {@link ParseDecodeDefectError} carries. */
const PARSE_DECODE_DEFECT = 'PARSE_DECODE_DEFECT';

/**
 * The parent thread could not rebuild a worker's answer: a VAT defect, never a
 * fact about the document.
 *
 * No input the worker emits can make the parent's decode throw: the codec is
 * loops end to end, so no size or depth reaches a throw, and the worker emits
 * only a plain-mapping root (`isPlainMapping`, `frontmatter-codec.ts`) the
 * decode accepts. A throw there is therefore rethrown loud by
 * every lane: never stored as `BLOB_PARSE_FAILED`, never a per-file finding
 * that blames the document. `classifyParseFailure` rethrows it, as it
 * rethrows every failure not on its allowlist.
 */
export class ParseDecodeDefectError extends VatError {
  constructor(cause: unknown) {
    super(
      PARSE_DECODE_DEFECT,
      `VAT could not rebuild a parse worker's answer on the parent thread (${cause instanceof Error ? cause.message : String(cause)}). This is a VAT defect, not a problem with the document; please report it.`,
      { cause },
    );
  }
}

/** A parse outcome that belongs to this run, never to the bytes: a limit breach or a worker's death. */
export type PerRunParseRefusal = ParseLimitError | ParseWorkerDiedError;

/**
 * Whether a thrown value is a per-run parse outcome: the set no lane ever
 * stores (ADR I6), and that every crawl lane refuses for one file and
 * re-attempts on the next run.
 *
 * @param error - Anything a parse threw
 * @returns True for a limit breach or a worker's death
 */
export function isPerRunParseRefusal(error: unknown): error is PerRunParseRefusal {
  return isParseLimitError(error) || isParseWorkerDiedError(error);
}

/** What a parser threw, as the worker flattened it: `ParseWorkerFailure` minus the brand. */
interface ParserThrow {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
}

/** The brand {@link reviveParserThrow} sets on a throw the parser made from the bytes. */
const FROM_DOCUMENT = Symbol('parser-threw-from-document');

/**
 * Rebuild a parser's throw on this side of the worker boundary, branded when
 * it was the PARSER's, made from the bytes: the one failure that is a fact
 * about a document, and so the only one a lane may store as
 * `BLOB_PARSE_FAILED` (ADR I6).
 *
 * The worker sets the brand (`fromDocument` on its reply) only around the
 * parser's own call over the content. Everything else a parse can reject with
 * — a worker entry that cannot be found or spawned, a reply that could not be
 * posted, a protocol defect — arrives unbranded, and every lane rethrows it
 * loud instead of filing VAT's own defect under the bytes' content key.
 * Nothing classifies by message text.
 *
 * Not the original class — structured clone cannot carry one — but it wears
 * the original `name`, `message`, `stack` and, critically, `code`: the stored
 * condition's reason is built from them (`parseFailedMessage`). A brand on a
 * plain `Error`, not a subclass, so every reader of `code` keeps reading the
 * parser's own.
 *
 * @param thrown - The flattened throw
 * @param fromDocument - Whether the worker branded it as the parser's own
 * @returns The rebuilt error
 */
export function reviveParserThrow(thrown: ParserThrow, fromDocument: boolean): Error {
  const error: Error & { code?: string } = new Error(thrown.message);
  error.name = thrown.name;
  if (thrown.stack !== undefined) error.stack = thrown.stack;
  if (thrown.code !== undefined) error.code = thrown.code;
  if (fromDocument) Object.defineProperty(error, FROM_DOCUMENT, { value: true });
  return error;
}

/**
 * @param error - Anything a parse threw
 * @returns True only for a throw the parser made from the bytes — see {@link reviveParserThrow}
 */
export function isParserThrewError(error: unknown): error is Error & { readonly code?: string } {
  return error instanceof Error && Object.hasOwn(error, FROM_DOCUMENT);
}

/** Bytes per MiB. */
const BYTES_PER_MIB = 1_048_576;

/**
 * Whether a worker's heap has passed the limit the pool enforces on it.
 *
 * The measure is the WHOLE used heap, young generation included. A worker's
 * own space statistics are out of the parent's reach (`Worker` has
 * `getHeapStatistics` and no `getHeapSpaceStatistics` on Node 26), so the old
 * generation alone cannot be read; subtracting the young generation at its
 * 96 MiB ceiling instead understates it by up to that much, which measured on
 * Node 26 let a worker reach V8's own ceiling unseen and kill the process. The
 * whole heap never understates the old generation, so a job is stopped no
 * later than its old generation passes the limit.
 *
 * @param stats - `Worker.getHeapStatistics()`
 * @param limitMb - The enforced limit — see {@link heapBounds}
 * @returns True once the used heap is past the limit
 */
export function exceedsHeapLimit(stats: { readonly used_heap_size: number }, limitMb: number): boolean {
  return stats.used_heap_size > limitMb * BYTES_PER_MIB;
}

/**
 * How far V8's own heap ceiling for a worker sits above the limit the pool
 * enforces: V8's ceiling is this many times the enforced one.
 *
 * V8 reaching a worker's ceiling is not a recoverable `ERR_WORKER_OUT_OF_MEMORY`
 * under fast allocation: measured on Node 26, a worker given 64 MiB and parsing
 * a 200,000-link document dies with a FATAL "Reached heap limit" that kills the
 * WHOLE process in 3 runs of 4. Node grants a dying worker 16 MiB of leeway, and
 * a parse allocating ~300 MiB/s outruns it before termination lands. So V8's
 * ceiling is never the enforcer: the pool's heap sampler stops the job at the
 * enforced limit, and the ceiling is headroom past it the sampler cannot miss
 * (one 50 ms sample interval allocates ~15 MiB at that rate). The cost is a
 * lazier V8 garbage collector below a higher ceiling, so garbage counts toward
 * `heapMb` until it is collected.
 */
const HEAP_CEILING_FACTOR = 2;

/**
 * V8's old-generation ceiling for a worker whose enforced limit is `heapMb`.
 *
 * @param heapMb - The configured limit
 * @returns `resourceLimits.maxOldGenerationSizeMb` — see {@link HEAP_CEILING_FACTOR}
 */
export function workerHeapCeilingMb(heapMb: number): number {
  return heapMb * HEAP_CEILING_FACTOR;
}

/**
 * The least room, in MiB, a floored bound leaves below V8's ceiling: twice
 * what a job allocates in one heap-sample interval at the fastest rate
 * measured (~300 MiB/s over 50 ms, ~15 MiB), so a sample a whole interval late
 * still stops the job before V8 does. See {@link heapBounds}.
 */
const SAMPLER_HEADROOM_MB = 32;

/** The heap bounds of one worker, as a heap sample reads them. */
export interface HeapBounds {
  /** The limit the pool's sampler enforces on what the worker's heap holds — see {@link heapBreached}. */
  readonly appliedMb: number;
  /** V8's own old-generation ceiling for the worker, past which V8 stops it. */
  readonly ceilingMb: number;
  /**
   * The used heap past which the sampler stops a job without waiting for a
   * collection to say what of it is held — see {@link heapBreached}.
   */
  readonly stopMb: number;
}

/**
 * The heap limit the pool enforces on a worker, and V8's own ceiling above it, in MiB.
 *
 * `heap_size_limit` is V8's old-generation ceiling plus the young
 * generation's (measured on Node 26: 2,048 + 96 = 2,144 for `heapMb` 1,024). A
 * process-wide `--max-old-space-size` overrides `resourceLimits` in BOTH
 * directions: higher, and the ceiling only moves further away; lower, and the
 * pool cannot raise it, so it enforces {@link HEAP_CEILING_FACTOR} below
 * whatever ceiling V8 applies, and a refusal names that lower value, not the
 * configured one.
 *
 * That share is floored at the young generation's own size, while the ceiling
 * leaves {@link SAMPLER_HEADROOM_MB} above the floor. The sampler counts the
 * whole used heap ({@link exceedsHeapLimit}), and the young generation holds
 * up to its size in garbage between scavenges: measured on Node 26, a cold
 * worker parsing an ordinary 34 KB document peaks at 54 to 68 MiB used (20
 * runs at every flag from none to 64 MiB), so under a 128 MiB flag the half
 * share (64 MiB) refused about one ordinary document in ten. A ceiling too
 * low for floor plus headroom keeps the half share: such a flag is too small
 * to parse with, and refusing is right.
 *
 * @param stats - `Worker.getHeapStatistics()`
 * @param youngGenerationMb - The worker's `resourceLimits.maxYoungGenerationSizeMb`
 * @param heapMb - The configured limit
 * @returns The enforced limit (never above `heapMb`) and V8's ceiling as read
 */
export function heapBounds(
  stats: { readonly heap_size_limit: number },
  youngGenerationMb: number,
  heapMb: number,
): HeapBounds {
  const readMb = Math.floor(stats.heap_size_limit / BYTES_PER_MIB) - youngGenerationMb;
  const ceilingMb = readMb > 0 ? readMb : workerHeapCeilingMb(heapMb);
  const share = Math.floor(ceilingMb / HEAP_CEILING_FACTOR);
  const floor = Math.min(youngGenerationMb, ceilingMb - SAMPLER_HEADROOM_MB);
  const appliedMb = readMb > 0 ? Math.min(heapMb, Math.max(share, floor)) : heapMb;
  return { appliedMb, ceilingMb, stopMb: unvouchedStopMb(appliedMb, ceilingMb, heapMb) };
}

/**
 * Where the sampler stops a job no collection has vouched for: halfway from
 * the applied bound to V8's ceiling, the ceiling taken as never above
 * {@link workerHeapCeilingMb} (a process-wide flag that lifts V8's ceiling
 * does not lift the stop), never within {@link SAMPLER_HEADROOM_MB} of the
 * ceiling, and never below the bound itself.
 *
 * Half the room is the trade between the two ways a used heap past the bound
 * can be misread: garbage V8 has not yet collected (the room below the stop),
 * and a parent stalled while a true breach allocates toward V8's ceiling (the
 * room above it) — see {@link heapBreached}.
 *
 * @param appliedMb - The applied bound
 * @param ceilingMb - V8's ceiling as read
 * @param heapMb - The configured limit
 * @returns The stop, in MiB
 */
function unvouchedStopMb(appliedMb: number, ceilingMb: number, heapMb: number): number {
  const roomTopMb = Math.min(ceilingMb, workerHeapCeilingMb(heapMb));
  const halfwayMb = appliedMb + Math.floor((roomTopMb - appliedMb) / 2);
  return Math.max(appliedMb, Math.min(halfwayMb, ceilingMb - SAMPLER_HEADROOM_MB));
}

/**
 * Whether one heap sample shows a job holding more than its applied bound.
 *
 * The used heap counts garbage V8 has not collected yet, and V8 collects
 * lazily below a ceiling set well past the bound ({@link HEAP_CEILING_FACTOR}).
 * Measured on Node 24 under a loaded host, a worker parsing a 10,000-level
 * blockquote that holds 420 to 460 MiB live read 1,079 MiB used, rising with no
 * collection, so the used heap alone refused a document a quarter of the way
 * to its limit. A used heap past the bound is therefore a breach only once an
 * old-generation collection has run: a sample that fell from its predecessor
 * by more than the young generation can hold (a scavenge frees at most that),
 * so what it still reads is held. A heap that rises past {@link HeapBounds.stopMb}
 * with no such collection is stopped there anyway, so V8's ceiling, which can
 * kill the whole process, is never left to stop a job. A young generation of
 * unknown size makes any fall a collection: the pool refuses sooner, never later.
 *
 * @param stats - This sample, from `Worker.getHeapStatistics()`
 * @param previousUsedBytes - The same job's previous sample, if one landed
 * @param bounds - {@link heapBounds}
 * @param youngGenerationMb - The worker's `resourceLimits.maxYoungGenerationSizeMb`
 * @returns True when the job is to be stopped at its heap limit
 */
export function heapBreached(
  stats: { readonly used_heap_size: number },
  previousUsedBytes: number | undefined,
  bounds: HeapBounds,
  youngGenerationMb: number,
): boolean {
  if (!exceedsHeapLimit(stats, bounds.appliedMb)) return false;
  if (exceedsHeapLimit(stats, bounds.stopMb)) return true;
  return previousUsedBytes !== undefined
    && previousUsedBytes - stats.used_heap_size > youngGenerationMb * BYTES_PER_MIB;
}

/** A pool's width and each worker's enforced heap limit. */
interface PoolShape {
  readonly size: number;
  readonly heapMb: number;
}

/**
 * MiB the bound holds back for the main thread — the projection, the run
 * caches and the store — before any worker heap is counted against memory.
 */
const MAIN_THREAD_RESERVE_MB = 1024;

/**
 * The least enforced heap a memory-bounded worker is given. A judgement, not a
 * measurement: it is the young generation's own ceiling (see
 * {@link exceedsHeapLimit}), so a worker on a machine too small for one default
 * worker can still hold an ordinary document, and a larger one is refused as a
 * per-run heap breach rather than taking the process down.
 */
const MIN_BOUNDED_HEAP_MB = 96;

/**
 * Bound a pool's total heap by the memory the machine actually has.
 *
 * Every worker may grow to V8's ceiling, {@link workerHeapCeilingMb} of its
 * enforced limit, so a pool's worst case is `size × workerHeapCeilingMb(heapMb)`
 * on top of the main thread. That product is held inside `memoryBytes` (a
 * container's limit where one is set — see `machineMemoryBytes` in
 * `parse-pool.ts`) minus {@link MAIN_THREAD_RESERVE_MB}. Width is lowered
 * first, since a narrower pool refuses nothing; only when even one worker does
 * not fit is the heap limit lowered, floored at {@link MIN_BOUNDED_HEAP_MB}. A
 * width someone pinned (`VAT_PARSE_POOL_SIZE`, a policy) is capped the same
 * way: no route to the pool skips it.
 *
 * @param requested - The width and heap limit asked for
 * @param memoryBytes - The memory this process may use
 * @returns The width and heap limit the pool runs at; never above what was asked
 */
export function memoryBoundedPool(requested: PoolShape, memoryBytes: number): PoolShape {
  const availableMb = Math.floor(memoryBytes / BYTES_PER_MIB) - MAIN_THREAD_RESERVE_MB;
  const width = Math.floor(availableMb / workerHeapCeilingMb(requested.heapMb));
  if (width >= 1) return { size: Math.min(requested.size, width), heapMb: requested.heapMb };
  const fitting = Math.max(MIN_BOUNDED_HEAP_MB, Math.floor(availableMb / HEAP_CEILING_FACTOR));
  return { size: 1, heapMb: Math.min(requested.heapMb, fitting) };
}

/**
 * How many idle threads a process may keep parked beside a pool running at its worst case.
 *
 * A parked thread (see `parkedWorkers` in `parse-pool.ts`) is idle, so it is charged its whole
 * enforced limit, `heapMb`: twice the used heap it may be parked with, leaving room for what V8
 * committed beyond it. What is charged comes out of what {@link memoryBoundedPool} left after
 * `pool` grew every thread to {@link workerHeapCeilingMb}, so parked threads never take the
 * memory a live pool was bounded by. A pool whose heap the bound lowered leaves none; one whose
 * width it lowered leaves only what the narrower pool's worst case does not fill, often none.
 *
 * @param pool - The widest pool this process runs at this shape, as {@link memoryBoundedPool} bounded it
 * @param memoryBytes - The memory this process may use
 * @returns How many threads of this shape may be parked; `0` parks none
 */
export function parkedThreadRoom(pool: PoolShape, memoryBytes: number): number {
  const availableMb = Math.floor(memoryBytes / BYTES_PER_MIB) - MAIN_THREAD_RESERVE_MB;
  const spareMb = availableMb - pool.size * workerHeapCeilingMb(pool.heapMb);
  return Math.max(0, Math.floor(spareMb / pool.heapMb));
}

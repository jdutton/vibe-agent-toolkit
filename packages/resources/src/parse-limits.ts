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
   *   {@link appliedHeapLimitMb}
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
   * never). It names that ceiling — {@link workerHeapCeilingMb} of the bound
   * the sampler enforces — never the sampler's bound, which did not stop it.
   *
   * @param appliedMb - The bound the sampler enforced, from the last sample to
   *   land, or `undefined` when none landed: then the ceiling is unknown, since
   *   a process-wide `--max-old-space-size` overrides it in either direction
   * @param configuredMb - The `heapMb` this pool was given
   * @returns The breach
   */
  static heapCeiling(appliedMb: number | undefined, configuredMb: number): ParseLimitError {
    if (appliedMb === undefined) {
      return new ParseLimitError(
        'heapMb',
        workerHeapCeilingMb(configuredMb),
        undefined,
        `V8's own heap ceiling, reached before the pool's heap sampler read it: ${LIMIT_UNITS.heapMb(workerHeapCeilingMb(configuredMb))}, unless a process-wide --max-old-space-size set it instead`,
      );
    }
    const ceilingMb = workerHeapCeilingMb(appliedMb);
    return new ParseLimitError(
      'heapMb',
      ceilingMb,
      undefined,
      `V8's own heap ceiling, ${LIMIT_UNITS.heapMb(ceilingMb)} — twice the ${String(appliedMb)} MiB the pool's heap sampler enforces, reached before the sampler read the heap past it`,
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
 * in full.
 */
interface ExpandedSize {
  /** Every array element and every mapping entry of that JSON, at every depth. */
  readonly rows: number;
  /** Bytes of that JSON, exactly: `Buffer.byteLength(JSON.stringify(value))` for an acyclic value. */
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
 * Whether JSON writes a value's own children: an array, or an object with no
 * `toJSON` of its own — which writes its own enumerable keys, so a `Set` or a
 * `Map` (a `!!set`, a `!!omap`) is `{}` and a bare `Uint8Array` its indices.
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
 * length; a `!!set` / `!!omap` is the `{}` JSON writes.
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

/** An output cap a parse result breached, and what the result measured against it. */
interface OutputBreach {
  readonly limit: 'outputDepth' | 'outputRows' | 'outputBytes';
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
  limits: Pick<ParseLimits, 'outputDepth' | 'outputRows' | 'outputBytes'>,
): OutputBreach | undefined {
  const facts: Partial<ParseResult> = { ...result };
  delete facts.content;
  delete facts.sizeBytes;
  delete facts.frontmatter;
  const expanded = result.frontmatter === undefined ? { rows: 0, bytes: 0, depth: 0 } : expandedSize(result.frontmatter);
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
 * only a plain-mapping root (`isPlainMapping`, `frontmatter-source.ts`) the
 * decode accepts. A throw there is therefore rethrown loud by
 * every lane: never stored as `BLOB_PARSE_FAILED`, never a per-file finding
 * that blames the document. Classified by {@link isParseDecodeDefect}.
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

/**
 * @param error - Anything a parse threw
 * @returns True for a {@link ParseDecodeDefectError}, or anything wearing its code
 */
export function isParseDecodeDefect(error: unknown): error is ParseDecodeDefectError {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === PARSE_DECODE_DEFECT;
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
 * @param limitMb - The enforced limit — see {@link appliedHeapLimitMb}
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
 * The heap limit the pool enforces on a worker, in MiB.
 *
 * `heap_size_limit` is V8's old-generation ceiling plus the young
 * generation's (measured on Node 26: 2,048 + 96 = 2,144 for `heapMb` 1,024). A
 * process-wide `--max-old-space-size` overrides `resourceLimits` in BOTH
 * directions: higher, and the ceiling only moves further away; lower, and the
 * pool cannot raise it, so it enforces {@link HEAP_CEILING_FACTOR} below
 * whatever ceiling V8 applies, and a refusal names that lower value, not the
 * configured one.
 *
 * @param stats - `Worker.getHeapStatistics()`
 * @param youngGenerationMb - The worker's `resourceLimits.maxYoungGenerationSizeMb`
 * @param heapMb - The configured limit
 * @returns The smaller of the configured limit and the headroom-safe share of V8's ceiling
 */
export function appliedHeapLimitMb(
  stats: { readonly heap_size_limit: number },
  youngGenerationMb: number,
  heapMb: number,
): number {
  const ceiling = Math.floor(stats.heap_size_limit / BYTES_PER_MIB) - youngGenerationMb;
  return ceiling > 0 ? Math.min(heapMb, Math.floor(ceiling / HEAP_CEILING_FACTOR)) : heapMb;
}

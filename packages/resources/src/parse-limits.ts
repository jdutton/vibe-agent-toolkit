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
 * a 1,000-level nested list parses in 10.6 s and a 10,000-level one does not
 * finish; 10,000 nested `>` overflow the stack.
 *
 * ## Why a breach persists nothing (I6)
 *
 * Time, heap and stack outcomes depend on the machine and its load, not on the
 * bytes, so a breach is filed nowhere: no parse-cache entry, no stored failure.
 * The next run re-attempts the pair. Output and input caps ARE functions of the
 * bytes, but storing them is the "failures stored under their limit" step the
 * ADR defers, so for now they are per-run too — one rule, no second lane.
 *
 * ## Where the values come from
 *
 * The lab, never preference. The headroom rule and the measured record behind
 * each value are in `docs/architecture/fact-extractors-limits.md`; change a value
 * there and here together.
 */

import { VatError } from '@vibe-agent-toolkit/utils';

/** The limits one parse job runs under. */
export interface ParseLimits {
  /** Wall-clock milliseconds a job may take, from dispatch to answer. */
  readonly timeMs: number;
  /** A worker's old-generation heap ceiling, in MiB (`resourceLimits.maxOldGenerationSizeMb`). */
  readonly heapMb: number;
  /** A worker's stack, in MiB (`resourceLimits.stackSizeMb`) — what bounds parser recursion. */
  readonly stackMb: number;
  /** Rows one job may produce, counted over every array the facts carry. */
  readonly outputRows: number;
  /** Bytes one job's facts may serialise to. */
  readonly outputBytes: number;
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
 * 1,000-level nested list, 10.6 s) plus a cold worker's parser load, with
 * headroom for a loaded machine. Named for what they bound, never a version.
 */
const DEFAULT_PARSE_LIMITS: ParseLimits = {
  timeMs: 30_000,
  heapMb: 1024,
  stackMb: 4,
  outputRows: 16_384,
  outputBytes: 4 * 1024 * 1024,
  inputBytes: 8 * 1024 * 1024,
};

/** How each limit is spelled to a user, so a refusal names the bound in its own unit. */
const LIMIT_UNITS: Readonly<Record<ParseLimitName, (value: number) => string>> = {
  timeMs: (value) => `${value} ms wall clock`,
  heapMb: (value) => `${value} MiB heap`,
  stackMb: (value) => `${value} MiB stack`,
  outputRows: (value) => `${value} output rows`,
  outputBytes: (value) => `${value} output bytes`,
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

  constructor(limit: ParseLimitName, value: number, bound: string = LIMIT_UNITS[limit](value)) {
    super(PARSE_LIMIT_EXCEEDED, `The parse was stopped at its ${limit} limit (${bound}).`);
    this.limit = limit;
    this.bound = bound;
  }

  /**
   * A heap breach, naming the limit that actually applied.
   *
   * @param appliedMb - The old-generation ceiling the worker ran under — see {@link appliedHeapLimitMb}
   * @param configuredMb - The `heapMb` this pool was given
   * @returns The breach, saying so when a process-wide flag lowered the limit
   */
  static heap(appliedMb: number, configuredMb: number): ParseLimitError {
    const bound = LIMIT_UNITS.heapMb(appliedMb);
    return new ParseLimitError(
      'heapMb',
      appliedMb,
      appliedMb < configuredMb
        ? `${bound}, lowered from ${String(configuredMb)} MiB by a process-wide --max-old-space-size`
        : bound,
    );
  }
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
 * The old generation's size, from a worker's heap statistics: the ONE measure
 * `heapMb` is defined over (`resourceLimits.maxOldGenerationSizeMb`).
 *
 * A worker's own space statistics are out of the parent's reach: `Worker` has
 * `getHeapStatistics` and no `getHeapSpaceStatistics` (Node 26), and a worker
 * busy in a synchronous parse answers no message of its own. So the young
 * generation is subtracted at its ceiling. The result never overstates the old
 * generation, so the sampler stops a job only once its old generation is
 * provably past the limit, which is where V8 itself stops one when no
 * process-wide flag overrides `resourceLimits`.
 *
 * @param stats - `Worker.getHeapStatistics()`
 * @param youngGenerationMb - The worker's `resourceLimits.maxYoungGenerationSizeMb`
 * @returns Bytes the old generation holds, at least
 */
export function oldGenerationBytes(stats: { readonly used_heap_size: number }, youngGenerationMb: number): number {
  return Math.max(0, stats.used_heap_size - youngGenerationMb * BYTES_PER_MIB);
}

/**
 * The old-generation ceiling a worker actually runs under, in MiB.
 *
 * `heap_size_limit` is the old generation's ceiling plus the young
 * generation's (measured on Node 26: 1,024 + 96 = 1,120). A process-wide
 * `--max-old-space-size` overrides `resourceLimits` in BOTH directions: higher,
 * and the sampler is what holds `heapMb`; lower, and V8 stops the worker below
 * `heapMb`, so a refusal must name the lower value, not the configured one.
 *
 * @param stats - `Worker.getHeapStatistics()`
 * @param youngGenerationMb - The worker's `resourceLimits.maxYoungGenerationSizeMb`
 * @param heapMb - The configured limit
 * @returns The smaller of the configured limit and the one V8 enforces
 */
export function appliedHeapLimitMb(
  stats: { readonly heap_size_limit: number },
  youngGenerationMb: number,
  heapMb: number,
): number {
  const enforced = Math.floor(stats.heap_size_limit / BYTES_PER_MIB) - youngGenerationMb;
  return enforced > 0 ? Math.min(heapMb, enforced) : heapMb;
}

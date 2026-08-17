/**
 * Output utilities for structured data
 * YAML output on stdout, logs on stderr
 */

import { writeSync } from 'node:fs';

import * as yaml from 'yaml';

/**
 * Write `content` to stdout SYNCHRONOUSLY, in a loop until every byte is handed
 * over.
 *
 * `process.stdout.write` is asynchronous whenever stdout is a PIPE, and every
 * command in this CLI calls `process.exit()` the moment it has written its
 * summary. `process.exit` does not drain a pending write, so everything past the
 * first pipe buffer (64 KB on Linux/macOS) was silently discarded — with exit
 * code 0, so nothing signalled the loss. An interactive TTY is unbuffered and
 * looked perfect, which is why this survived: it only bites the piped consumer
 * this CLI's own docs recommend (`vat command | jq .status`).
 *
 * `writeSync` cannot return before the bytes reach the pipe, so `process.exit`
 * has nothing left to lose. The loop is required because a single `writeSync`
 * may accept fewer bytes than offered.
 *
 * This is the same fix `help-loader.ts` applied to `--help --verbose`; it lives
 * here so both callers share one implementation rather than two copies of a
 * subtle loop.
 */
export function writeStdoutSync(content: string): void {
  writeAllSync(
    (buffer, offset, length) => writeSync(1, buffer, offset, length),
    Buffer.from(content, 'utf8'),
  );
}

/**
 * A synchronous write primitive: `(buffer, offset, length) => bytesWritten`.
 *
 * Matches `fs.writeSync`'s shape so the real one drops straight in, while a test
 * can supply one that returns short counts or throws EAGAIN on demand.
 */
export type SyncWriter = (buffer: Buffer, offset: number, length: number) => number;

/**
 * How many CONSECUTIVE EAGAIN retries — retries during which the writer accepted
 * zero bytes — are tolerated before the write is declared stalled.
 *
 * Consecutive, not cumulative: a large payload to a slow reader legitimately
 * EAGAINs thousands of times in total, and every one of those is followed by
 * progress. What is never legitimate is the pipe staying full while the process
 * on the other end takes nothing at all. Combined with the wait below, the
 * budget is roughly ten seconds of a completely stalled reader.
 */
const MAX_CONSECUTIVE_EAGAIN_RETRIES = 10_000;

/** Consecutive retries to spin on before sleeping between attempts. */
const EAGAIN_SPIN_RETRIES = 16;

/**
 * Sleep synchronously. Required because this whole path exists to run to
 * completion before `process.exit`, so it cannot yield to the event loop; a
 * timer would never fire. `Atomics.wait` on a never-notified buffer is the one
 * primitive that blocks the thread without burning CPU.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Spin for the first few retries — a draining pipe frees space in microseconds,
 * and paying a millisecond for that would be absurd — then back off to a real
 * sleep so a genuinely stalled reader is waited out rather than spun on.
 */
function defaultWaitBetweenRetries(consecutiveRetries: number): void {
  if (consecutiveRetries > EAGAIN_SPIN_RETRIES) sleepSync(1);
}

export interface WriteAllSyncOptions {
  /** Override {@link MAX_CONSECUTIVE_EAGAIN_RETRIES}. Tests use a tiny budget. */
  maxConsecutiveRetries?: number;
  /** Override the backoff. Tests pass a no-op to drive the bound instantly. */
  waitBetweenRetries?: (consecutiveRetries: number) => void;
}

/**
 * Drive `write` until every byte of `buffer` has been accepted.
 *
 * Split out from {@link writeStdoutSync} because the things that make this loop
 * necessary — a short write, and an EAGAIN retry on a momentarily-full
 * non-blocking pipe — are both hard to provoke on a real fd and trivial to state
 * against an injected writer. The fd-1 wiring stays a one-liner above, so the
 * only part with branching logic is the part that can be unit tested.
 *
 * The EAGAIN retry is BOUNDED. A reader that stops draining without closing the
 * pipe (`vat … | consumer-that-wanders-off`) leaves it permanently full, so
 * every retry raises EAGAIN forever; an unbounded loop turns that into a hang
 * with no output and no error — strictly worse than the truncation this replaced.
 * Exhausting the budget throws, so the failure is visible and the exit code is
 * non-zero, rather than the bytes quietly going missing.
 *
 * @throws the underlying error for any failure other than EAGAIN; an `Error`
 * naming the unwritten remainder when the retry budget is exhausted.
 */
export function writeAllSync(
  write: SyncWriter,
  buffer: Buffer,
  options: WriteAllSyncOptions = {},
): void {
  const maxRetries = options.maxConsecutiveRetries ?? MAX_CONSECUTIVE_EAGAIN_RETRIES;
  const wait = options.waitBetweenRetries ?? defaultWaitBetweenRetries;

  let written = 0;
  let consecutiveRetries = 0;

  while (written < buffer.length) {
    try {
      const n = write(buffer, written, buffer.length - written);
      // A writer that reports no progress would spin forever. Treat it as a
      // failure rather than hang the CLI.
      if (n <= 0) {
        throw new Error(`Refusing to loop forever: writer accepted ${n} bytes of ${buffer.length - written} remaining`);
      }
      written += n;
      consecutiveRetries = 0;
    } catch (error) {
      // A non-blocking pipe whose buffer is momentarily full raises EAGAIN; a
      // reader that is draining will free space, so retry. Anything else is a
      // genuine write failure.
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      consecutiveRetries++;
      if (consecutiveRetries > maxRetries) {
        throw new Error(
          `Write stalled: ${maxRetries} consecutive EAGAIN retries with no progress after ${written} of ${buffer.length} bytes. The reader is not draining the pipe.`,
        );
      }
      wait(consecutiveRetries);
    }
  }
}

/**
 * Write a single YAML document to stdout, opened with `---`.
 *
 * There is deliberately NO trailing marker. `---` OPENS a document in YAML; the
 * end-of-document marker is `...`. Emitting `---` at the end therefore opened a
 * second, empty document, so every command's stdout was a two-document stream and
 * a plain `YAML.parse()` threw `Source contains multiple documents` — on output
 * this CLI documents as "YAML summary → stdout (for programmatic parsing)".
 *
 * The repo's own test helper had already been written around it: `executeCli…`
 * calls `parseAllDocuments(...)` and takes `docs[0]`, with a comment saying "to
 * handle document markers". That workaround is what kept the defect invisible —
 * every consumer that did the obvious thing instead got an exception.
 *
 * Dropping the trailer also makes this agree with the seven hand-rolled emit
 * sites elsewhere in the CLI, none of which ever wrote one.
 *
 * @param data - Data to serialize as YAML
 */
export function writeYamlOutput(data: unknown): void {
  // Deliberately the ordinary stream write, NOT writeStdoutSync: this summary
  // follows human-readable progress output written via console.log, and a
  // synchronous fd-1 write would jump ahead of anything still buffered there.
  // Completeness is guaranteed instead by makeStdioBlocking() at startup, which
  // makes BOTH channels synchronous and keeps them in order.
  process.stdout.write(`---\n${yaml.stringify(data, {
    indent: 2,
    lineWidth: 120,
    aliasDuplicateObjects: false,
  })}`);
}

/**
 * Write a single JSON document to stdout.
 *
 * The sibling of {@link writeYamlOutput}, for the same payloads, and it exists
 * because a consumer that has to parse YAML needs a YAML parser: JSON is the
 * format every language reads without one. `vat resources validate` already
 * offers `--format json` for exactly this reason; a scan document that could
 * only be had as YAML made the population it reports the harder of the two to
 * consume programmatically, which is backwards.
 *
 * Written the same way as its YAML sibling, and the comment there applies
 * verbatim: the ordinary stream write keeps this summary behind any
 * human-readable progress already buffered on the same channel.
 *
 * @param data - Data to serialize as JSON
 */
export function writeJsonOutput(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Write a test-format finding to stderr.
 *
 * Format: `file:line:column: severity: message` — the GCC/ESLint-compact
 * convention, which every editor and CI log scraper already parses.
 *
 * The severity is not decoration. Only `error` findings fail the run, so a
 * reader who cannot see the severity cannot tell which lines of a long report
 * they have to act on. Omitting it made an info-severity note byte-identical in
 * shape to a build-breaking error.
 */
export function writeTestFormatError(
  file: string,
  line: number,
  column: number,
  severity: string,
  message: string
): void {
  process.stderr.write(`${file}:${line}:${column}: ${severity}: ${message}\n`);
}

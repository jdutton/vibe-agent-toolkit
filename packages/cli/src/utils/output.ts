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
 * Make stdout/stderr BLOCKING, so that `process.exit()` can never discard output.
 *
 * Call once, first thing, from the CLI entry point.
 *
 * Node makes a pipe's stdio non-blocking, which is what turns `console.log` and
 * `process.stdout.write` into buffered, asynchronous writes. `process.exit` does
 * not drain those buffers, so every command in this CLI — all of which exit the
 * moment they finish — could lose whatever had not yet reached the pipe.
 *
 * Fixing this at the single YAML writer would have worked for stdout — this CLI
 * keeps structured output and human-readable output on separate streams, so
 * stdout has exactly one writer and there is nothing for a synchronous write to
 * jump ahead of. It is done here instead because the same truncation applies to
 * STDERR, which carries the progress lines and the `file:line:column: severity:`
 * findings, and a report that loses its tail at 64 KB is worse than one that
 * never printed. One mechanism covers both streams and every writer, present and
 * future, rather than each output helper having to remember.
 *
 * `setBlocking` is the libuv behaviour behind `process.stdout` and the mechanism
 * Node itself uses for TTYs; it is reached through the stream's internal handle,
 * so every access is guarded and a failure is non-fatal — a platform where this
 * is unavailable simply keeps the previous behaviour rather than crashing the
 * CLI at startup.
 */
export function makeStdioBlocking(): void {
  for (const stream of [process.stdout, process.stderr]) {
    try {
      const handle = (stream as unknown as { _handle?: { setBlocking?: (blocking: boolean) => void } })._handle;
      handle?.setBlocking?.(true);
    } catch {
      // Best-effort: never let a startup nicety take down the CLI.
    }
  }
}

/**
 * A synchronous write primitive: `(buffer, offset, length) => bytesWritten`.
 *
 * Matches `fs.writeSync`'s shape so the real one drops straight in, while a test
 * can supply one that returns short counts or throws EAGAIN on demand.
 */
export type SyncWriter = (buffer: Buffer, offset: number, length: number) => number;

/**
 * Drive `write` until every byte of `buffer` has been accepted.
 *
 * Split out from {@link writeStdoutSync} because the two things that make this
 * loop necessary — a short write, and an EAGAIN retry on a momentarily-full
 * non-blocking pipe — are both hard to provoke on a real fd and trivial to state
 * against an injected writer. The fd-1 wiring stays a one-liner above, so the
 * only part with branching logic is the part that can be unit tested.
 *
 * @throws the underlying error for any failure other than EAGAIN.
 */
export function writeAllSync(write: SyncWriter, buffer: Buffer): void {
  let written = 0;
  while (written < buffer.length) {
    try {
      const n = write(buffer, written, buffer.length - written);
      // A writer that reports no progress would spin forever. Treat it as a
      // failure rather than hang the CLI.
      if (n <= 0) {
        throw new Error(`Refusing to loop forever: writer accepted ${n} bytes of ${buffer.length - written} remaining`);
      }
      written += n;
    } catch (error) {
      // A non-blocking pipe whose buffer is momentarily full raises EAGAIN; the
      // reader will drain it, so retry. Anything else is a genuine write failure.
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
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
 * Flush stdout before writing to stderr
 * Prevents output corruption when streams are merged
 */
export async function flushStdout(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.stdout.writableNeedDrain) {
      process.stdout.once('drain', resolve);
    } else {
      resolve();
    }
  });
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

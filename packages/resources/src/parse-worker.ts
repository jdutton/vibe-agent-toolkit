/**
 * The worker-thread half of {@link file://./parse-pool.ts}.
 *
 * This module is an ENTRY POINT, not a library: it runs its work in a top-level
 * message listener and has no exports. `parse-pool.ts` starts it by path and
 * never imports it, so nothing here is reachable from the main thread's module
 * graph — which is exactly what makes the pool's laziness real. See
 * `resolveWorkerEntry` there for why the started file is always the BUILT
 * JavaScript, in a `dist/` run and under vitest alike.
 *
 * ## What it does, and the two things it deliberately does not
 *
 * It receives a decoded document and returns parse facts. It does **not** read
 * the file — the parent already read it once, and the projection's
 * `RunContentCache` guarantees that "once" — and it does **not** return
 * `content`, which the parent still holds. `toParseWire` (in `parse-pool.ts`,
 * which owns the protocol) performs that reduction, so the shape the worker
 * sends and the shape the parent rebuilds from are one definition rather than
 * two that can drift.
 *
 * ## Why the parser is loaded through `loadParser` rather than imported
 *
 * `loadParser` memoizes per kind and imports nothing until asked, so a worker
 * that only ever sees HTML never pays remark's ~730 ms module load, and a worker
 * that never receives a message pays nothing at all. Importing
 * `parseMarkdownContent` at the top of this file instead would load the whole
 * remark stack in every worker the moment the thread starts — including the
 * threads a short batch never dispatches to.
 *
 * It also means a broken install fails here the same way it fails on the main
 * thread: as a `ParserUnavailableError`, whose `code` {@link describeFailure}
 * carries across the boundary so `isParserUnavailable` still recognises it.
 *
 * ## Why the timings go back over the port, and why `close()` is not `process.exit()`
 *
 * This thread writes no file. Its parse-timing counters are posted to the parent
 * in answer to the shutdown request and merged into the ONE dump the process
 * writes — see `ParseTimingDump` in `parse-timing.ts` for why that is the shape.
 * Answering before the close is what makes the numbers independent of this
 * thread's exit path: an `exit` listener runs only under a graceful close, and
 * measured on Node 24.13.1 a port close exits 0 with listeners run while
 * `worker.terminate()` from the parent exits 1 with them skipped — and which of
 * those happens is the parent's decision, not this thread's.
 *
 * `close()` rather than `process.exit()` for a plain reason: it drains the loop,
 * which is what lets the queued reply — the timing message included — leave.
 */

import { parentPort, workerData } from 'node:worker_threads';

import type { ParseResult } from './link-parser.js';
import { loadParser, ParseCache } from './parse-cache.js';
import {
  type ParseWorkerData,
  type ParseWorkerFailure,
  type ParseWorkerRequest,
  type ParseWorkerResponse,
  toParseWire,
} from './parse-pool.js';
import {
  parseTimingStart,
  readThreadTiming,
  recordTierPass,
  TierPass,
} from './parse-timing.js';

if (parentPort === null) {
  throw new Error(
    "VAT's parse worker is a worker-thread entry point and cannot run on the main thread. " +
      'Use createParsePool() from parse-pool.js instead.',
  );
}

/** Narrowed once, so every use below is free of the `null` case. */
const port = parentPort;

/**
 * Flatten a thrown value into something structured clone can carry.
 *
 * `code` is the load-bearing field: `isParserUnavailable` matches on it as well
 * as on `instanceof`, and an error rebuilt in the parent is necessarily a plain
 * `Error`. Dropping the code would silently downgrade a broken VAT install into
 * an ordinary per-document failure — the exact defect `ParserUnavailableError`
 * exists to close.
 *
 * @param error - Whatever the parser or its loader threw
 * @returns The failure as plain data, with no undefined-valued keys
 */
function describeFailure(error: unknown): ParseWorkerFailure {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };

  const code: unknown = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

/**
 * Parse one document and answer the parent.
 *
 * Never throws: a parser failure becomes a {@link ParseWorkerFailure} the parent
 * re-raises, because an unhandled rejection in a worker kills the thread and
 * would take every other in-flight job on it down too.
 *
 * A document that merely parses BADLY is not a failure at all — parse5's
 * well-formedness diagnostics ride back inside the facts, in `parseErrors`.
 *
 * @param request - The document and the parser to run over it
 */
async function respond(request: Extract<ParseWorkerRequest, { type: 'parse' }>): Promise<void> {
  const jobStartedAt = parseTimingStart();
  let response: ParseWorkerResponse;
  try {
    const parser = await loadParser(request.kind);
    // `byteLength` is the parent's RAW byte count, passed through untouched —
    // never a length derived from `content`, since decoding is lossy.
    const result = parser.parseContent(request.content, request.byteLength);
    response = await answerFor(request, result);
  } catch (error) {
    response = { id: request.id, failure: describeFailure(error) };
  }
  const replyStartedAt = parseTimingStart();
  port.postMessage(response);
  // The reply's serialization, charged on THIS thread. Under the wire transport
  // it is the whole fact graph; under cache transport it is one string. That
  // difference is half of what the transport experiment is asking about, and the
  // other half — the parent's deserialization — is not bracketable at all (see
  // `settleJob` in parse-pool.ts).
  recordTierPass(TierPass.WorkerReply, replyStartedAt);
  recordTierPass(TierPass.WorkerJob, jobStartedAt);
}

/**
 * Turn a fresh parse into the answer the parent asked for.
 *
 * ## Why a failed cache write falls back instead of failing
 *
 * The parse already happened and its facts are in hand. A cache that cannot be
 * written to — `VAT_CACHE=0`, a read-only mount, a full disk, a shard directory
 * another local user pre-created — is a persistence problem, and answering
 * `stored` when nothing was stored would send the parent to read an entry that
 * is not there. It would then get `null` from its own cache and have no facts at
 * all, having paid for the parse twice over. So a write that did not persist
 * sends the facts over the wire instead.
 *
 * ⚠️ **`setByKey`'s boolean is the authority, and it had to be added for this.**
 * `ParseCache` is fail-SOFT: every failure path returned `void`, so there was
 * nothing to believe and the first version of this function proved the write by
 * reading the entry back. Measured, that cost 1,677 extra reads and decodes per
 * cold adopter run — ~1.0 s of worker time — to learn something the writer
 * already knew. Reporting it is strictly better than re-discovering it.
 *
 * @param request - The job, carrying a `cacheKey` when cache transport was asked for
 * @param result - What the parser produced
 * @returns The `stored` answer, or the facts
 */
async function answerFor(
  request: Extract<ParseWorkerRequest, { type: 'parse' }>,
  result: ParseResult,
): Promise<ParseWorkerResponse> {
  const { cacheKey } = request;
  if (cacheKey === undefined) return { id: request.id, facts: toParseWire(result) };

  const persisted = await workerCache().setByKey(cacheKey, result);
  if (!persisted) return { id: request.id, facts: toParseWire(result) };
  return { id: request.id, stored: cacheKey };
}

/**
 * This thread's parse cache, created on first use.
 *
 * Lazy for the same reason `defaultParseCache` is: `ParseCache` reads `VAT_CACHE`
 * once per construction, so building it at module load would bind the decision to
 * import time. A worker that never receives a cache-transport request never
 * constructs one.
 *
 * Its own instance rather than the process-wide one, because there is no such
 * thing across isolates — each worker has its own module graph. The consequence
 * worth stating: this instance's `writeFailures` counter is invisible to the
 * parent's `ParseCacheStats`, which is why {@link answerFor} reports a failed
 * write through the PROTOCOL instead of leaving it to a statistic nobody reads.
 */
let cache: ParseCache | undefined;

/**
 * @returns This thread's cache instance
 */
function workerCache(): ParseCache {
  // The parent's store, never this isolate's idea of the default one — see
  // `ParsePoolOptions.cacheDir` for what an unshared directory costs and why the
  // failure is silent.
  const given: unknown = workerData;
  const cacheDir =
    typeof given === 'object' && given !== null && typeof (given as ParseWorkerData).cacheDir === 'string'
      ? (given as ParseWorkerData).cacheDir
      : undefined;
  cache ??= new ParseCache(cacheDir === undefined ? {} : { cacheDir });
  return cache;
}

port.on('message', (request: ParseWorkerRequest) => {
  if (request.type === 'shutdown') {
    // The counters are final the moment there is no job left, which is now — so
    // they go back over this channel BEFORE the port closes, and the parent
    // writes them. Nothing here writes a file: see `ParseTimingDump` in
    // `parse-timing.ts` for what one writer per process buys.
    const timing = readThreadTiming();
    if (timing !== null) port.postMessage({ timing });
    port.close();
    return;
  }
  respond(request).catch((error: unknown) => {
    // `respond` already catches everything the PARSER can throw, so reaching
    // here means the RESPONSE itself could not be posted — a value structured
    // clone refuses. Answering with a failure keeps that one document's promise
    // settled; an unhandled rejection would kill the thread and take every
    // other job on it with it. The failure payload is plain data, so this
    // second post cannot fail the same way.
    port.postMessage({ id: request.id, failure: describeFailure(error) });
  });
});

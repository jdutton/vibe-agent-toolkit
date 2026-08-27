/**
 * A fake {@link ParsePool} that runs the real parsers, for the suites whose
 * subject is the LOOP rather than the transport.
 *
 * Shared by both crawl lanes' pool suites — `projection-blob-population-pool`
 * and `resource-registry-pool` — because both ask the same three questions of
 * their loop (does it emit in order however the pool answers, is the fan-out
 * bounded, is the pool shut down on both exits) and a second copy of the fake
 * is a second place for the answers to drift. `parse-pool.test.ts` owns the
 * transport; nothing here re-tests it.
 */

import { parseHtmlContent } from '../src/html-link-parser.js';
import { type ParseResult, parseMarkdownContent } from '../src/link-parser.js';
import type { DocumentParserKind } from '../src/mime-type.js';
import type { ParsePool } from '../src/parse-pool.js';

/** What a fake pool observed about the way a lane drove it. */
export interface PoolRecord {
  /** Documents dispatched to the pool, ever. */
  calls: number;
  /** Currently outstanding, used only to maintain {@link PoolRecord.maxInFlight}. */
  inFlight: number;
  /** The widest fan-out the lane ever produced — the EMFILE-relevant number. */
  maxInFlight: number;
  /** `shutdown()` calls. Must be exactly 1, on the success AND the throw path. */
  shutdowns: number;
}

/** How a fake pool should behave beyond parsing. */
export interface FakePoolBehaviour {
  /**
   * Reject every dispatched document with the error this builds from its bytes.
   *
   * A FUNCTION of the content, not a fixed `Error`, because "which failure
   * surfaced" is a question one shared error object cannot answer: two documents
   * rejecting with the same instance cannot distinguish a corpus-ordered raise
   * from a completion-ordered one. A caller that does not care ignores the
   * argument.
   */
  failWith?: (content: string) => Error;
  /** Answer in reverse dispatch order, so completion order ≠ emission order. */
  reverseCompletion?: boolean;
  /**
   * Answer with empty facts instead of running the real parser.
   *
   * ⛔ **Only for a fixture whose subject is the DECISION to pool, not the rows.**
   * The corpus a sizing test needs is measured in megabytes — that is the whole
   * point of it — and running remark over those megabytes in-process, which is
   * what this fake does, costs seconds and proves nothing the assertion reads.
   * Any fixture that asserts on derived rows must leave this off, or it asserts
   * on rows the parser never produced.
   */
  emptyFacts?: boolean;
}

/**
 * A well-formed `ParseResult` that asserts nothing about the document.
 *
 * See {@link FakePoolBehaviour.emptyFacts}. Every required field is present and
 * every optional one absent, so a consumer that walks it behaves exactly as it
 * would for a document that genuinely had no links, headings or frontmatter.
 *
 * @param content - The document's decoded content, carried through verbatim
 * @param sizeBytes - Its raw byte count, carried through verbatim
 * @returns Facts with nothing in them
 */
function emptyParse(content: string, sizeBytes: number): ParseResult {
  return { links: [], headings: [], content, sizeBytes, estimatedTokenCount: 0 };
}

/** Milliseconds per step of the reversed-completion ladder. */
const COMPLETION_STEP_MS = 4;

/**
 * How far the reversed ladder counts down from.
 *
 * Larger than the fixtures that care about completion order, so the first
 * document dispatched is the last to answer. Floored at zero below, so a fixture
 * with hundreds of documents — which cannot care about the ladder anyway —
 * simply runs it out rather than asking for a negative delay.
 */
const LADDER_TOP = 32;

/**
 * Pause, so a fake pool can answer out of dispatch order.
 *
 * @param ms - How long to wait
 */
async function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A pool that parses in-process but records how the loop drove it.
 *
 * It runs the REAL parsers, so anything derived through it is identical to what
 * the un-pooled path derives — which is what lets a suite assert on order and on
 * fan-out without also re-testing the transport.
 *
 * @param size - The width the loop should read off `pool.size`
 * @param behaviour - Failure and completion-order options
 * @returns The pool and the record it writes into
 */
export function fakePool(
  size: number,
  behaviour: FakePoolBehaviour = {},
): { pool: ParsePool; record: PoolRecord } {
  const record: PoolRecord = { calls: 0, inFlight: 0, maxInFlight: 0, shutdowns: 0 };

  const pool: ParsePool = {
    size,
    parse: async (
      kind: DocumentParserKind,
      content: string,
      byteLength: number,
    ): Promise<ParseResult> => {
      record.calls += 1;
      const dispatchIndex = record.calls;
      record.inFlight += 1;
      record.maxInFlight = Math.max(record.maxInFlight, record.inFlight);
      try {
        // Always a real timer, never a bare microtask: a fake that answered
        // without yielding to the loop would show `maxInFlight === 1` however
        // wide the fan-out was, and every order assertion would be vacuous.
        await delay(
          behaviour.reverseCompletion === true
            ? Math.max(0, LADDER_TOP - dispatchIndex) * COMPLETION_STEP_MS
            : 1,
        );
        if (behaviour.failWith !== undefined) throw behaviour.failWith(content);
        if (behaviour.emptyFacts === true) return emptyParse(content, byteLength);
        return kind === 'html'
          ? parseHtmlContent(content, byteLength)
          : parseMarkdownContent(content, byteLength);
      } finally {
        record.inFlight -= 1;
      }
    },
    // Never reached by either suite: both drive a DISABLED cache, and
    // `ParseDispatcher` forces the wire transport when the cache cannot BE one.
    // It throws rather than answering `null`, so a change that starts routing
    // here fails loudly instead of falling through to a cache read that finds
    // nothing.
    parseIntoCache: async (): Promise<never> => {
      throw new Error('cache transport is not exercised by these suites');
    },
    shutdown: async (): Promise<void> => {
      record.shutdowns += 1;
    },
  };

  return { pool, record };
}

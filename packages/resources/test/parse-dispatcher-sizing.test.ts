/**
 * What the pool's width is sized FROM.
 *
 * A document is not a unit of parse work. Two facts make the count that used to
 * stand here the wrong question, and both are measured:
 *
 * - **Kind.** `remark-parse` costs roughly 24x per byte what `parse5` costs, so
 *   a corpus of HTML is nearly free and a corpus of markdown is not. Counting
 *   documents charges them the same.
 * - **Size.** A repository of 300 stub READMEs and a repository of 300 manuals
 *   are the same count and two orders of magnitude apart in bytes.
 *
 * So the sizing asks how many milliseconds of serial parse the remainder is
 * worth, and buys a worker only when there are enough of them to pay for one.
 * These cases pin that rule at both of its edges: the corpus that must buy
 * threads, and the several shapes of corpus that must not.
 */

import { describe, expect, it } from 'vitest';

import { NO_PARSER_KIND, type ParsableContent, type ParserKind } from '../src/content-key.js';
import {
  ParseDispatcher,
  type ParsableRemainder,
  type ParsePoolPolicy,
  tallyParsable,
} from '../src/parse-dispatcher.js';
import { defaultParsePoolSize, type ParsePool, type ParsePoolOptions } from '../src/parse-pool.js';

import { type CacheOutcomes, inertPool, mutableCache } from './parse-dispatcher-fixture.js';

/** A document size in the range a real corpus sits in — a large adopter's mean is ~17 KB. */
const TYPICAL_DOCUMENT_BYTES = 20_000;

/** Small enough that a corpus of them is not worth a thread however many there are. */
const STUB_DOCUMENT_BYTES = 100;

/** A remainder big enough in COUNT to have bought two workers under the old rule. */
const LONG_TAIL = 300;

/** One sampled document of a given kind and size. */
function sampleDocument(kind: 'markdown' | 'html', byteLength: number): ParsableContent {
  return {
    content: '',
    decoding: { encoding: 'utf-8', declared: false, replacements: 0 },
    key: `${kind}.${'0'.repeat(64)}`,
    parserKind: kind,
    byteLength,
  } as unknown as ParsableContent;
}

/** A zeroed remainder, so a case names only the kind it is about. */
function remainderOf(counts: Partial<ParsableRemainder>): ParsableRemainder {
  return { markdown: 0, html: 0, ...counts };
}

/** What one run offers the sizing: a sample it parsed, then what is left. */
interface Sizing {
  /** Documents the dispatcher observed, in `parse()` order. */
  sample: readonly ParsableContent[];
  /** What the lane says is still to be parsed. */
  remaining: ParsableRemainder;
  /** Cache outcomes the run accrued; `misses` also clears the threshold. */
  outcomes?: CacheOutcomes;
  /** Extra policy, for the cases that pin precedence. */
  policy?: ParsePoolPolicy;
}

/**
 * Run one sizing decision and report the width the pool was asked for.
 *
 * @param sizing - The sample, the remainder and the run's cache outcomes
 * @returns The size the pool was built with, or `null` when none was built
 */
async function widthFor(sizing: Sizing): Promise<number | null> {
  let asked: number | null = null;
  const { cache, accrue } = mutableCache();
  const dispatcher = new ParseDispatcher(cache, {
    enabled: true,
    missThreshold: 1,
    ...sizing.policy,
    createPool: (options?: ParsePoolOptions): ParsePool => {
      asked = options?.size ?? null;
      return inertPool();
    },
  });
  for (const document of sizing.sample) await dispatcher.parse(document);
  accrue(sizing.outcomes ?? { misses: sizing.sample.length });
  dispatcher.considerActivation(() => sizing.remaining);
  return asked;
}

/**
 * Whether this box can afford a useful pool at all.
 *
 * A machine with fewer than three cores caps below {@link MINIMUM_WORKERS}, so
 * it must start no pool however rich the corpus is. Asserted from the other side
 * rather than skipped: a skip on a small CI runner is a hole.
 */
const CAN_AFFORD_A_POOL = defaultParsePoolSize() >= 2;

describe('sizing the pool from parsable BYTES', () => {
  it('buys workers for a remainder whose bytes are worth their module load', async () => {
    // 300 documents at 20 KB is ~5.7 MB of markdown, ~2.1 s of serial parse at
    // the measured 370 ms/MB — above the two-worker break-even.
    const width = await widthFor({
      sample: [sampleDocument('markdown', TYPICAL_DOCUMENT_BYTES)],
      remaining: remainderOf({ markdown: LONG_TAIL }),
    });

    expect(width).toBe(CAN_AFFORD_A_POOL ? 2 : null);
  });

  it('buys none for the same COUNT of stub documents', async () => {
    // The whole reason the unit moved. 300 documents is 300 documents; 30 KB of
    // markdown is a third of a millisecond of parsing, and no arrangement of
    // threads makes that worth ~723 ms of module load.
    const width = await widthFor({
      sample: [sampleDocument('markdown', STUB_DOCUMENT_BYTES)],
      remaining: remainderOf({ markdown: LONG_TAIL }),
    });

    expect(width).toBeNull();
  });

  it('buys none for the same BYTES of HTML', async () => {
    // parse5 costs ~42 ms/MB against remark's ~370. The byte total that buys two
    // workers of markdown parsing is ~9x short of buying one of HTML — which is
    // the corpus the pool was measured to make 5.5% SLOWER.
    const width = await widthFor({
      sample: [sampleDocument('html', TYPICAL_DOCUMENT_BYTES)],
      remaining: remainderOf({ html: LONG_TAIL }),
    });

    expect(width).toBeNull();
  });

  it('makes no claim about a kind it has no sample of', async () => {
    // The estimate projects observed document sizes onto the remaining count. A
    // kind nothing has parsed yet has no observed size, and inventing one would
    // buy threads for a corpus this run has seen no evidence of.
    const width = await widthFor({
      sample: [sampleDocument('markdown', TYPICAL_DOCUMENT_BYTES)],
      remaining: remainderOf({ html: LONG_TAIL * 100 }),
    });

    expect(width).toBeNull();
  });

  it('discounts the remainder by the run\'s own cache hit rate', async () => {
    // A warm run reaches the miss threshold and still has almost nothing to
    // parse: measured, 50.3% of a warm crawl re-keys files it does not reparse.
    // Counting every remaining parsable document as a parse would size the pool
    // for work the cache is about to answer for free.
    const width = await widthFor({
      sample: [sampleDocument('markdown', TYPICAL_DOCUMENT_BYTES)],
      remaining: remainderOf({ markdown: LONG_TAIL }),
      outcomes: { hits: 900, misses: 100 },
    });

    expect(width).toBeNull();
  });

  it('caps a corpus that could pay for any number of threads', async () => {
    const width = await widthFor({
      sample: [sampleDocument('markdown', TYPICAL_DOCUMENT_BYTES)],
      remaining: remainderOf({ markdown: 1_000_000 }),
    });

    expect(width).toBe(CAN_AFFORD_A_POOL ? defaultParsePoolSize() : null);
  });

  it('never starts a pool of one, however the arithmetic lands', async () => {
    // A one-worker pool parallelizes nothing — width is the fan-out, so the main
    // thread hands over a document and then waits for a thread to do work it
    // could have done itself, having paid a structured clone each way and a
    // remark load once. Measured at +723 ms: the pool's whole fixed cost, bought
    // and not used. The two ways of spending nothing are "no pool" and "a pool
    // that helps"; there is no third.
    const width = await widthFor({
      sample: [sampleDocument('markdown', TYPICAL_DOCUMENT_BYTES)],
      // ~1.5 s of parse: enough for one worker's share, not for two.
      remaining: remainderOf({ markdown: 215 }),
    });

    expect(width).toBeNull();
  });

  it('scans the remainder ONCE even when the answer is "no pool"', async () => {
    // 🚨 The loop offers this decision after every emission, and the tally
    // behind it is an O(remaining) scan. A decline that did not stick would
    // re-scan at every one of them — O(n²) over the corpus — for an answer that
    // cannot change in the direction that matters, since the remainder only
    // shrinks. Byte-sized corpora decline far more often than counted ones did,
    // so this is the common path.
    let scans = 0;
    const { cache, accrue } = mutableCache();
    const dispatcher = new ParseDispatcher(cache, {
      enabled: true,
      missThreshold: 1,
      createPool: (): ParsePool => inertPool(),
    });
    await dispatcher.parse(sampleDocument('markdown', STUB_DOCUMENT_BYTES));
    accrue({ misses: 1 });

    for (let emission = 0; emission < 20; emission += 1) {
      dispatcher.considerActivation(() => {
        scans += 1;
        return remainderOf({ markdown: LONG_TAIL });
      });
    }

    expect(scans).toBe(1);
  });

  it('leaves an explicitly sized pool alone, and never scans the remainder for it', async () => {
    // A caller that named a width knows something the estimate does not, and the
    // scan behind the remainder is O(remaining) — paying for it to discard the
    // answer is the cost the callback shape exists to avoid.
    let scans = 0;
    const { cache, accrue } = mutableCache();
    let asked: number | null = null;
    const dispatcher = new ParseDispatcher(cache, {
      enabled: true,
      missThreshold: 1,
      size: 6,
      createPool: (options?: ParsePoolOptions): ParsePool => {
        asked = options?.size ?? null;
        return inertPool();
      },
    });
    accrue({ misses: 1 });
    dispatcher.considerActivation(() => {
      scans += 1;
      return remainderOf({ markdown: LONG_TAIL });
    });

    expect(asked).toBe(6);
    expect(scans).toBe(0);
  });
});

describe('tallyParsable — the remainder both lanes supply', () => {
  /** A path-shaped target, routed the way the registry lane routes one. */
  const kindOfName = (name: string): ParserKind => {
    if (name.endsWith('.md')) return 'markdown';
    return name.endsWith('.html') ? 'html' : NO_PARSER_KIND;
  };

  it('keeps the kinds APART, because they are not the same work', () => {
    // 🔑 The tally is the only place the corpus's kind mix reaches the sizing,
    // and the two kinds are ~24x apart per byte. A tally that collapsed them
    // would price an HTML corpus as markdown and open a pool for the exact tree
    // the pool was measured to make 5.5% SLOWER.
    expect(tallyParsable(['a.md', 'b.html', 'c.md', 'd.html', 'e.html'], 0, kindOfName)).toStrictEqual(
      { markdown: 2, html: 3 },
    );
  });

  it('excludes what reaches no parser at all', () => {
    // Those targets never touch the pool, so counting them would size it against
    // work it will never be given. On this repository that is not a rounding
    // error: 6,967 of 8,713 documents route to `none`.
    expect(tallyParsable(['a.md', 'b.ts', 'c.json', 'd.lock'], 0, kindOfName)).toStrictEqual({
      markdown: 1,
      html: 0,
    });
  });

  it('counts from the given index onwards, never from the head', () => {
    // Targets before it are claimed or emitted already; buying threads for work
    // that is in flight is buying threads for work that will be done first.
    expect(tallyParsable(['a.md', 'b.md', 'c.md', 'd.html'], 2, kindOfName)).toStrictEqual({
      markdown: 1,
      html: 1,
    });
  });

  it('answers every kind at zero rather than omitting it', () => {
    // An absent kind and an empty one must never have to be told apart — the
    // estimate reads every kind unconditionally.
    expect(tallyParsable([], 0, kindOfName)).toStrictEqual({ markdown: 0, html: 0 });
  });
});

describe('the pool width cap', () => {
  it('stops at four, which is where the measured width curve knees', async () => {
    // Measured on a 10-core box, cold `vat resources validate` on a 103-skill
    // adopter: 3 -> 4 buys a real 528 ms (2.0x the 261 ms noise floor), 4 -> 8
    // buys 83 ms (0.3x it, indistinguishable). Four threads is where the curve
    // stops paying, and every thread past it is a remark heap and a module load
    // bought for nothing.
    expect(defaultParsePoolSize()).toBeLessThanOrEqual(4);
  });
});

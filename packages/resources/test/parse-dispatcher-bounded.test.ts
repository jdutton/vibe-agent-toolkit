/**
 * Every parse the dispatcher runs goes through the bounded pool (I8).
 *
 * There is no in-process route left: not below the activation threshold, not
 * under any environment. A parse on the run's own thread cannot be stopped at a
 * limit, so its existence alone would break termination. And a parse stopped at
 * a limit is filed nowhere (I6).
 */

import { readWorkCounters } from '@vibe-agent-toolkit/utils';
import { __resetWorkCountersForTest } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';

import type { ParsableContent } from '../src/content-key.js';
import type { ParseResult } from '../src/link-parser.js';
import type { ParseCache } from '../src/parse-cache.js';
import { type DataContent, ParseDispatcher, type ParsePoolPolicy } from '../src/parse-dispatcher.js';
import type { ParseLimits } from '../src/parse-limits.js';
import { ParseLimitError } from '../src/parse-limits.js';
import type { ParsePool, ParsePoolOptions } from '../src/parse-pool.js';
import { __readParseTimingSnapshot } from '../src/parse-timing.js';
import { POPULATION_PARSE_LIMITS } from '../src/projection/content-cache.js';
import type { TsconfigJobInput } from '../src/projection/tsconfig-parse.js';
import { skillTextFactsOf } from '../src/skill-text/core.js';
import { SKILL_TEXT_DECLARATION } from '../src/skill-text/declaration.js';
import { testContentKey } from '../src/testing.js';

import { TIGHT_LIMITS } from './parse-limit-fixtures.js';

const DOCUMENT: ParsableContent = {
  content: '# hi\n',
  decoding: { encoding: 'utf-8', encodingSource: 'assumed', replacementCharacters: 0 },
  key: testContentKey('markdown', '0'),
  parserKind: 'markdown',
  byteLength: 5,
};

/** A cache that always misses, and records what was written into it. */
function missingCache(): { cache: ParseCache; written: string[] } {
  const written: string[] = [];
  const stats = { hits: 0, misses: 0 };
  const cache = {
    enabled: true,
    directory: '/nowhere/cache',
    stats,
    get: (): Promise<null> => {
      stats.misses += 1;
      return Promise.resolve(null);
    },
    set: (keyed: ParsableContent): Promise<void> => {
      written.push(keyed.key);
      return Promise.resolve();
    },
  } as unknown as ParseCache;
  return { cache, written };
}

/** A pool that answers every parse with `answer`, recording what it was built with and asked. */
function recordingPool(answer: () => Promise<ParseResult>): {
  createPool: (options?: ParsePoolOptions) => ParsePool;
  built: (ParsePoolOptions | undefined)[];
  parses: () => number;
} {
  const built: (ParsePoolOptions | undefined)[] = [];
  let parses = 0;
  return {
    built,
    parses: () => parses,
    createPool: (options?: ParsePoolOptions): ParsePool => {
      built.push(options);
      return {
        size: options?.size ?? 1,
        parse: () => {
          parses += 1;
          return answer();
        },
        parseIntoCache: () => Promise.reject(new Error('not used')),
        harnessFacts: () => Promise.reject(new Error('not used')),
        dataRows: () => Promise.reject(new Error('not used')),
        tsconfig: () => Promise.reject(new Error('not used')),
        shutdown: () => Promise.resolve(),
      };
    },
  };
}

const PARSED: ParseResult = {
  links: [],
  headings: [],
  content: DOCUMENT.content,
  sizeBytes: 5,
  estimatedTokenCount: 1,
  skillText: skillTextFactsOf(DOCUMENT.content, SKILL_TEXT_DECLARATION),
};

/**
 * One run of one document through a fresh dispatcher over a recording pool.
 *
 * @param cache - What the run reads and writes
 * @param policy - Everything but `createPool`, which the recording pool supplies
 * @returns The recording pool, to assert on what it was built with and asked
 */
async function parseOnce(
  cache: ParseCache,
  policy: Omit<ParsePoolPolicy, 'createPool'> = {},
): Promise<ReturnType<typeof recordingPool>> {
  const pool = recordingPool(() => Promise.resolve(PARSED));
  const dispatcher = new ParseDispatcher(cache, { ...policy, createPool: pool.createPool });
  await dispatcher.parse(DOCUMENT);
  await dispatcher.shutdown();
  return pool;
}

afterEach(() => {
  delete process.env['VAT_PARSE_POOL'];
});

describe('the dispatcher has one route, and it is bounded', () => {
  it('parses the very first miss in the pool, below any activation threshold', async () => {
    const pool = await parseOnce(missingCache().cache, { missThreshold: 1000 });

    expect(pool.parses()).toBe(1);
  });

  it('ignores VAT_PARSE_POOL=0 — there is no unbounded route to switch to', async () => {
    process.env['VAT_PARSE_POOL'] = '0';
    const pool = await parseOnce(missingCache().cache);

    expect(pool.parses()).toBe(1);
  });

  it('hands the policy\'s limits to the pool it builds', async () => {
    const limits: ParseLimits = TIGHT_LIMITS;
    const pool = await parseOnce(missingCache().cache, { limits });

    expect(pool.built[0]?.limits).toStrictEqual(limits);
  });

  it('files nothing for a parse stopped at a limit, and re-attempts it on the next run', async () => {
    const { cache, written } = missingCache();
    const pool = recordingPool(() => Promise.reject(new ParseLimitError('timeMs', 300)));

    for (let run = 0; run < 2; run += 1) {
      const dispatcher = new ParseDispatcher(cache, { createPool: pool.createPool });
      await expect(dispatcher.parse(DOCUMENT)).rejects.toMatchObject({ code: 'PARSE_LIMIT_EXCEEDED', limit: 'timeMs' });
      await dispatcher.shutdown();
    }

    expect(written).toStrictEqual([]);
    expect(pool.parses()).toBe(2);
  });

  it('builds no pool at all for a run that never misses', async () => {
    const stats = { hits: 0, misses: 0 };
    const cache = {
      enabled: true,
      directory: '/nowhere/cache',
      stats,
      get: (): Promise<ParseResult> => {
        stats.hits += 1;
        return Promise.resolve(PARSED);
      },
    } as unknown as ParseCache;
    const pool = await parseOnce(cache);

    expect(pool.built).toHaveLength(0);
  });
});

describe('the input cap a dispatcher hands its reads', () => {
  it('is the population\'s cap, whatever other limits are named', () => {
    const dispatcher = new ParseDispatcher(missingCache().cache, { limits: { outputRows: 1 } });

    expect(dispatcher.inputBytes).toBe(POPULATION_PARSE_LIMITS.inputBytes);
  });

  it('is the population\'s cap even when a caller passes `inputBytes` through a value typed ParseLimits', async () => {
    // The policy type omits `inputBytes`, but a `ParseLimits` variable carries it past that `Omit`
    // with no compile error: the cap is enforced at runtime, in the dispatcher and in its pool.
    const cap = POPULATION_PARSE_LIMITS.inputBytes;
    const limits: ParseLimits = { ...TIGHT_LIMITS, inputBytes: cap * 4 };
    const pool = recordingPool(() => Promise.resolve(PARSED));
    const dispatcher = new ParseDispatcher(missingCache().cache, { limits, createPool: pool.createPool });

    expect(dispatcher.inputBytes).toBe(cap);
    await expect(dispatcher.parse({ ...DOCUMENT, byteLength: cap + 1 })).rejects.toMatchObject({ limit: 'inputBytes' });
    await dispatcher.parse(DOCUMENT);
    await dispatcher.shutdown();

    expect(pool.built[0]?.limits).toStrictEqual({ ...TIGHT_LIMITS, inputBytes: cap });
  });

  it('refuses content past its cap before the cache is consulted, so an entry filed under a larger cap is not its answer', async () => {
    // Content handed over in memory (a frontmatter block, a ZIP entry) had no read to refuse it, and
    // an entry an earlier run filed under a larger cap would otherwise answer it here.
    let lookups = 0;
    const cache = {
      enabled: true,
      directory: '/nowhere/cache',
      stats: { hits: 0, misses: 0 },
      get: (): Promise<ParseResult> => {
        lookups += 1;
        return Promise.resolve(PARSED);
      },
    } as unknown as ParseCache;
    const cap = POPULATION_PARSE_LIMITS.inputBytes;
    const dispatcher = new ParseDispatcher(cache, {});

    await expect(dispatcher.parse({ ...DOCUMENT, byteLength: cap + 1 })).rejects.toMatchObject({
      code: 'PARSE_LIMIT_EXCEEDED',
      limit: 'inputBytes',
      bound: new ParseLimitError('inputBytes', cap).bound,
    });
    await dispatcher.shutdown();

    expect(lookups).toBe(0);
  });

  it('holds a cache hit to its own output caps, so an entry filed under looser ones is not its answer', async () => {
    // An entry a run under the default limits filed: two headings, past a one-row cap. Served as
    // filed, the hit would admit what this dispatcher's worker refuses.
    const filed: ParseResult = { ...PARSED, headings: [{ level: 1, text: 'a' }, { level: 1, text: 'b' }] as never };
    const cache = {
      enabled: true,
      directory: '/nowhere/cache',
      stats: { hits: 0, misses: 0 },
      get: (): Promise<ParseResult> => Promise.resolve(filed),
    } as unknown as ParseCache;
    const dispatcher = new ParseDispatcher(cache, { limits: { outputRows: 1 } });

    await expect(dispatcher.parse(DOCUMENT)).rejects.toMatchObject({ code: 'PARSE_LIMIT_EXCEEDED', limit: 'outputRows' });
    await dispatcher.shutdown();
  });

  it('holds a memory-file read to its cap in the bytes it was decoded from, never its text as UTF-8', async () => {
    // Three UTF-8 bytes per character, decoded from two each: the read's own count decides.
    const content = '字'.repeat(10);
    const asked: number[] = [];
    const pool = recordingPool(() => Promise.resolve(PARSED));
    const dispatcher = new ParseDispatcher(missingCache().cache, {
      createPool: (options) => ({
        ...pool.createPool(options),
        harnessFacts: (_harness, _content, byteLength) => {
          asked.push(byteLength);
          return Promise.resolve({ imports: [], rulePaths: [] } as never);
        },
      }),
    });

    await dispatcher.harnessFacts('claude-code', { content, byteLength: 20 });
    await dispatcher.shutdown();

    expect(asked).toStrictEqual([20]);
  });

  it('refuses a named limit that is not a positive number at construction, not at the first read', () => {
    expect(() => new ParseDispatcher(missingCache().cache, { limits: { outputRows: 0 } })).toThrow(/outputRows must be a positive finite number/);
  });
});

describe('cache transport whose read-back misses', () => {
  it('counts the document once as dispatched and its second parse as a re-dispatch', async () => {
    const { cache } = missingCache();
    // The worker reports the entry stored; the read-back finds nothing.
    Object.assign(cache, { read: (): Promise<null> => Promise.resolve(null) });
    const pool = recordingPool(() => Promise.resolve(PARSED));
    const createPool = (options?: ParsePoolOptions): ParsePool => ({
      ...pool.createPool(options),
      parseIntoCache: () => Promise.resolve(null),
    });
    const dispatcher = new ParseDispatcher(cache, { transport: 'cache', createPool });
    const before = readWorkCounters();

    await dispatcher.parse(DOCUMENT);
    await dispatcher.shutdown();

    // One document missed once: the parse-timing cache block reads
    // `parse.dispatched` as its misses, so hits plus misses stay documents.
    expect(pool.parses()).toBe(1);
    expect(readWorkCounters()['parse.dispatched'] - before['parse.dispatched']).toBe(1);
    expect(readWorkCounters()['parse.redispatched'] - before['parse.redispatched']).toBe(1);
    // The timing block reads the counters as they stand: zero them, then the
    // one document is one miss however many times it was dispatched.
    __resetWorkCountersForTest();
    onTestFinished(() => {
      __resetWorkCountersForTest();
    });
    const fresh = new ParseDispatcher(cache, { transport: 'cache', createPool });
    await fresh.parse(DOCUMENT);
    await fresh.shutdown();
    expect(__readParseTimingSnapshot().cache).toEqual({ hits: 0, misses: 1 });
  });
});

/** A data job as a recording pool was asked it. */
interface AskedDataJob {
  variant: string;
  byteLength: number;
  bom: boolean;
}

/**
 * A dispatcher over a recording pool with `members` laid over it, and a cache that records writes.
 *
 * @param members - The pool members the test answers itself
 * @returns The dispatcher, the pools it built and the cache entries it wrote
 */
function overriddenDispatcher(members: Partial<ReturnType<ReturnType<typeof recordingPool>['createPool']>>): {
  dispatcher: ParseDispatcher;
  built: (ParsePoolOptions | undefined)[];
  written: string[];
} {
  const pool = recordingPool(() => Promise.resolve(PARSED));
  const { cache, written } = missingCache();
  const dispatcher = new ParseDispatcher(cache, { createPool: (options) => ({ ...pool.createPool(options), ...members }) });
  return { dispatcher, built: pool.built, written };
}

/** A dispatcher whose pool records each data job it is asked, over a cache that records writes. */
function dataDispatcher(): {
  dispatcher: ParseDispatcher;
  asked: AskedDataJob[];
  built: (ParsePoolOptions | undefined)[];
  written: string[];
} {
  const asked: AskedDataJob[] = [];
  const overridden = overriddenDispatcher({
    dataRows: (variant, _content, byteLength, bom) => {
      asked.push({ variant, byteLength, bom });
      return Promise.resolve({ outcome: 'defect', code: 'DATA_PARSE_ERROR', message: 'seeded' });
    },
  });
  return { ...overridden, asked };
}

/** A UTF-8 decode, read off a BOM or assumed. */
function decoding(encodingSource: 'bom' | 'assumed'): DataContent['decoding'] {
  return { encoding: 'utf-8', encodingSource, replacementCharacters: 0 };
}

describe('a data extraction on the dispatcher', () => {
  it('hands the pool the variant, the raw byte count and the BOM its decode found, and files no cache entry', async () => {
    const { dispatcher, asked, written } = dataDispatcher();

    await dispatcher.dataRows('jsonc', { content: '{}', byteLength: 5, decoding: decoding('bom') });
    await dispatcher.dataRows('json', { content: '{}', byteLength: 2, decoding: decoding('assumed') });
    await dispatcher.shutdown();

    expect(asked).toStrictEqual([
      { variant: 'jsonc', byteLength: 5, bom: true },
      { variant: 'json', byteLength: 2, bom: false },
    ]);
    expect(written).toStrictEqual([]);
  });

  it('refuses content past the input cap at dispatch, counted, before a pool is built', async () => {
    const { dispatcher, asked, built } = dataDispatcher();
    const before = readWorkCounters()['parse.refused.inputCap.dispatch'];
    // The raw byte count decides, never the text: every dispatcher's cap is the population's.
    const byteLength = POPULATION_PARSE_LIMITS.inputBytes + 1;

    await expect(dispatcher.dataRows('json', { content: '[1]', byteLength, decoding: decoding('assumed') }))
      .rejects.toMatchObject({ code: 'PARSE_LIMIT_EXCEEDED', limit: 'inputBytes' });
    await dispatcher.shutdown();

    expect(readWorkCounters()['parse.refused.inputCap.dispatch'] - before).toBe(1);
    expect(asked).toStrictEqual([]);
    expect(built).toStrictEqual([]);
  });
});

describe('a tsconfig parse on the dispatcher', () => {
  it('hands the pool the job as given, building the pool for it, and files no cache entry', async () => {
    const asked: TsconfigJobInput[] = [];
    const { dispatcher, built, written } = overriddenDispatcher({
      tsconfig: (input) => {
        asked.push(input);
        return Promise.resolve({ outcome: 'requests', typescript: 'seeded', requests: ['tsconfig.json'] });
      },
    });
    const input: TsconfigJobInput = { root: '/r', configs: ['tsconfig.json'], texts: {}, listing: ['tsconfig.json'] };

    await expect(dispatcher.tsconfig(input)).resolves.toStrictEqual({ outcome: 'requests', typescript: 'seeded', requests: ['tsconfig.json'] });
    await dispatcher.shutdown();

    expect(asked).toStrictEqual([input]);
    expect(built).toHaveLength(1);
    expect(written).toStrictEqual([]);
  });
});

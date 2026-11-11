/**
 * Every parse the dispatcher runs goes through the bounded pool (I8).
 *
 * There is no in-process route left: not below the activation threshold, not
 * under any environment. A parse on the run's own thread cannot be stopped at a
 * limit, so its existence alone would break termination. And a parse stopped at
 * a limit is filed nowhere (I6).
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { ParsableContent } from '../src/content-key.js';
import type { ParseResult } from '../src/link-parser.js';
import type { ParseCache } from '../src/parse-cache.js';
import { ParseDispatcher, type ParsePoolPolicy } from '../src/parse-dispatcher.js';
import type { ParseLimits } from '../src/parse-limits.js';
import { ParseLimitError } from '../src/parse-limits.js';
import type { ParsePool, ParsePoolOptions } from '../src/parse-pool.js';

import { TIGHT_LIMITS } from './parse-limit-fixtures.js';

const DOCUMENT: ParsableContent = {
  content: '# hi\n',
  decoding: { encoding: 'utf-8', encodingSource: 'assumed', replacementCharacters: 0 },
  key: `markdown.${'0'.repeat(64)}`,
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
        shutdown: () => Promise.resolve(),
      };
    },
  };
}

const PARSED: ParseResult = { links: [], headings: [], content: '# hi\n', sizeBytes: 5, estimatedTokenCount: 1 };

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

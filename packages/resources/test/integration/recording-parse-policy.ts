/**
 * A parse-pool policy whose real, limited pool records what it is asked to parse, shared by the
 * integration tests that drive a parse limit through a crawl lane.
 */

import { overOutputRowsMarkdown } from '@vibe-agent-toolkit/utils/testing';

import type { ParsePoolPolicy } from '../../src/parse-dispatcher.js';
import { createParsePool, type ParsePool, type ParsePoolOptions } from '../../src/parse-pool.js';

/** Documents the pools the policy builds were handed, by first line. */
export interface Dispatched {
  firstLines: string[];
}

/**
 * A policy whose real, limited pool records what it is asked to parse.
 *
 * @param dispatched - Where each document the pool is handed is recorded, by first line
 * @param limits - The pool's limits: `{}` for the defaults
 * @returns The policy
 */
export function recordingPolicy(dispatched: Dispatched, limits: NonNullable<ParsePoolOptions['limits']>): ParsePoolPolicy {
  return {
    limits,
    createPool: (options?: ParsePoolOptions): ParsePool => {
      const real = createParsePool(options);
      return {
        size: real.size,
        parse: (kind, content, byteLength) => {
          dispatched.firstLines.push(content.split('\n')[0] ?? '');
          return real.parse(kind, content, byteLength);
        },
        parseIntoCache: (kind, content, byteLength, cacheKey) => real.parseIntoCache(kind, content, byteLength, cacheKey),
        harnessFacts: (harness, content, byteLength) => real.harnessFacts(harness, content, byteLength),
        shutdown: () => real.shutdown(),
      };
    },
  };
}

/**
 * More rows than the default `outputRows` (16,384) admits: frontmatter items, which parse in
 * milliseconds, where as many body links build a parse tree of hundreds of MiB and take seconds.
 */
export const overDefaultRows = (): string => overOutputRowsMarkdown(null);

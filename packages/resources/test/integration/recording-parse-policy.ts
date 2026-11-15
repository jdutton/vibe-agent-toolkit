/**
 * A parse-pool policy whose real, limited pool records what it is asked to parse, shared by the
 * integration tests that drive a parse limit through a crawl lane.
 */

import { overOutputRowsMarkdown } from '@vibe-agent-toolkit/utils/testing';

import { ParseCache } from '../../src/parse-cache.js';
import type { ParsePoolPolicy } from '../../src/parse-dispatcher.js';
import { createParsePool, type ParsePool, type ParsePoolOptions } from '../../src/parse-pool.js';
import { ResourceRegistry } from '../../src/resource-registry.js';

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
 * A registry over an enabled parse cache in `cacheDir`, parsing through `parsePool`.
 *
 * @param baseDir - The registry's base directory
 * @param cacheDir - The parse cache's directory
 * @param parsePool - The pool policy the registry parses through
 * @returns The registry
 */
export function registryOverCache(baseDir: string, cacheDir: string, parsePool: ParsePoolPolicy): ResourceRegistry {
  return new ResourceRegistry({ baseDir, parseCache: new ParseCache({ cacheDir, enabled: true }), parsePool });
}

/**
 * More rows than the default `outputRows` (16,384) admits: frontmatter items, which parse in
 * milliseconds, where as many body links build a parse tree of hundreds of MiB and take seconds.
 */
export const overDefaultRows = (): string => overOutputRowsMarkdown(null);

/**
 * A parse pool policy whose pool throws for the documents a test chooses and parses the rest for real.
 */

import type { ParsePoolPolicy } from '../../src/parse-dispatcher.js';
import { createParsePool, type ParsePool, type ParsePoolOptions } from '../../src/parse-pool.js';

/**
 * @param failureFor - The error a document's content makes the pool throw, or `undefined` to parse it for real
 * @returns The policy a crawl accepts as `parsePool`
 */
export function failingParsePolicy(failureFor: (content: string) => Error | undefined): ParsePoolPolicy {
  return {
    createPool: (options?: ParsePoolOptions): ParsePool => {
      const real = createParsePool(options);
      return {
        size: real.size,
        parse: (kind, content, byteLength) => {
          const error = failureFor(content);
          return error ? Promise.reject(error) : real.parse(kind, content, byteLength);
        },
        parseIntoCache: (kind, content, byteLength, cacheKey) => {
          const error = failureFor(content);
          return error ? Promise.reject(error) : real.parseIntoCache(kind, content, byteLength, cacheKey);
        },
        harnessFacts: (harness, content, byteLength) => real.harnessFacts(harness, content, byteLength),
        shutdown: () => real.shutdown(),
      };
    },
  };
}

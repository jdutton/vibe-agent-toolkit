/**
 * `loadTsconfigParser` (`parser-loader.ts`): a tsconfig parse module that cannot be loaded is a
 * `ParserUnavailableError` of the `typescript` kind naming the module, never a bare loader error;
 * a rejected load is dropped from the memo, so the next call loads again.
 *
 * Driven as `vendored-typescript-load-failure.test.ts` is: the module is mocked with an export
 * accessor that throws when read, which is the read the loader performs inside its `try`.
 */

import { describe, expect, it, vi } from 'vitest';

import { isParserUnavailable } from '../src/parse-cache.js';
import { loadTsconfigParser } from '../src/parser-loader.js';

const loader = vi.hoisted(() => ({ attempts: 0, failure: undefined as Error | undefined }));

vi.mock('../src/projection/tsconfig-parse.js', () => ({
  get loadTsconfigParse() {
    loader.attempts += 1;
    if (loader.failure) throw loader.failure;
    return () => Promise.resolve(() => ({ outcome: 'requests', typescript: 'stub', requests: [] }));
  },
}));

describe('loading the tsconfig parse in the worker', () => {
  it('wraps a module that will not load as the typescript kind, naming the module, and retries after it', async () => {
    const errno = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    loader.failure = errno;
    const error: unknown = await loadTsconfigParser().catch((thrown: unknown) => thrown);
    expect(isParserUnavailable(error)).toBe(true);
    expect(error).toMatchObject({ loaderError: errno });
    expect((error as Error).message).toContain("Cannot load VAT's typescript parser module (./projection/tsconfig-parse.js)");

    loader.failure = undefined;
    const before = loader.attempts;
    const parse = await loadTsconfigParser();
    expect(loader.attempts - before).toBe(1);
    expect(parse({ root: '/r', configs: [], texts: {}, listing: [] }, { inputBytes: 1, outputDepth: 1, outputRows: 1, outputBytes: 1 }))
      .toEqual({ outcome: 'requests', typescript: 'stub', requests: [] });
  });
});

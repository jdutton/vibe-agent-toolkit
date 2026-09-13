/**
 * `decodeTextContent`'s clean path is one FATAL decode, and a throw from it is
 * the only evidence that a substitution would happen — so the catch retries
 * leniently and counts replacement characters. The WHATWG contract is that a
 * fatal `TextDecoder` refuses with a `TypeError`, and that is the only failure
 * the lenient retry is an answer to. The catch used to be blind, so anything
 * else thrown from inside the decode was ALSO answered with a lenient decode
 * and a replacement count — a bug reported as a mildly damaged file.
 *
 * `TextDecoder` is stubbed globally and the module re-imported, because the
 * decoder table is built once at module load.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { decodeTextContent as DecodeTextContent } from '../src/text-content.js';

/** A `TextDecoder` whose fatal mode throws `failure`, and whose lenient mode answers `lenient`. */
function stubbedDecoder(failure: () => Error, lenient: string): void {
  class FakeTextDecoder {
    readonly #fatal: boolean;
    constructor(_encoding?: string, options?: { fatal?: boolean }) {
      this.#fatal = options?.fatal === true;
    }
    decode(): string {
      if (this.#fatal) throw failure();
      return lenient;
    }
  }
  vi.stubGlobal('TextDecoder', FakeTextDecoder);
}

async function freshDecodeTextContent(): Promise<typeof DecodeTextContent> {
  vi.resetModules();
  return (await import('../src/text-content.js')).decodeTextContent;
}

describe('decodeTextContent: only a fatal-decoder TypeError means "retry leniently"', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('retries leniently and counts replacements when the fatal decode refuses with a TypeError (positive control)', async () => {
    stubbedDecoder(() => new TypeError('The encoded data was not valid.'), 'a\u{FFFD}b');
    const decodeTextContent = await freshDecodeTextContent();
    expect(decodeTextContent(new Uint8Array([0x61, 0xff, 0x62]))).toEqual({
      text: 'a\u{FFFD}b',
      encoding: 'utf-8',
      encodingSource: 'assumed',
      replacementCharacters: 1,
    });
  });

  it('lets anything else thrown from inside the decode stay loud', async () => {
    stubbedDecoder(() => new RangeError('injected: not a decoding failure'), 'never');
    const decodeTextContent = await freshDecodeTextContent();
    expect(() => decodeTextContent(new Uint8Array([0x61]))).toThrow(RangeError);
  });
});

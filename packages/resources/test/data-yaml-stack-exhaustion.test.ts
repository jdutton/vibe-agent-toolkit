/**
 * The `yaml` variant's answer to the composer's own stack exhaustion: the composer catches a stack
 * overflow inside a collection and reports it as a `YAMLParseError` coded `RESOURCE_EXHAUSTION`,
 * and the extractor throws that error for the worker to report as the `stackMb` breach, never a
 * `DATA_PARSE_ERROR` a cache would store.
 *
 * The overflow is a real one, thrown by the engine, but it is raised by a collection tag this file
 * adds to the composer, at the top of the stack, rather than by nesting a document until the
 * composer itself runs out of stack. That is deliberate. After its catch the composer resolves an
 * empty scalar against the core schema's null pattern while still at the edge of the stack, and
 * V8 12.4 (Node 22) treats a regular-expression compile that meets the stack limit as a fatal
 * out-of-memory error (`RegExpCompiler Allocation failed`) that aborts the whole process, the
 * test runner included, instead of throwing. Whether a compile lands there depends on the frame
 * layout, so a deep document made this file abort the unit tier at the Node floor on some builds
 * and pass on others. A run never reaches that edge: each document is measured first and refused
 * past `outputDepth` before it is composed (`extractDataRows yaml: output caps` in `data-yaml.test.ts`).
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Yaml from 'yaml';

import { extractUnder } from './helpers/data-rows.js';

/** Recurse until the engine's own `RangeError`: a real stack overflow, raised one tag deep. */
function overflow(depth: number): number {
  return overflow(depth + 1) + 1;
}

/** A sequence tag whose resolution overflows the stack, inside the composer's collection catch. */
const OVERFLOWING_TAG = { tag: '!overflow', collection: 'seq', resolve: () => overflow(0) } as const;

vi.mock('yaml', async (importOriginal) => {
  const yaml = await importOriginal<typeof Yaml>();
  /** The library's composer, with the overflowing tag added to whatever the extractor configures. */
  class ComposerWithOverflowingTag extends yaml.Composer {
    constructor(options: ConstructorParameters<typeof yaml.Composer>[0] = {}) {
      super({ ...options, customTags: [OVERFLOWING_TAG] });
    }
  }
  return { ...yaml, Composer: ComposerWithOverflowingTag };
});

describe('extractDataRows yaml: the composer\'s stack exhaustion', () => {
  it('throws the composer\'s own stack exhaustion for the worker to report as the stack breach, never a parse error', () => {
    expect(() => extractUnder('a: !overflow [1]\n', {}, 'yaml'))
      .toThrow(expect.objectContaining({ name: 'YAMLParseError', code: 'RESOURCE_EXHAUSTION' }));
  });

  it('reads the same document without the tag as rows, so the throw is the overflow\'s alone', () => {
    expect(extractUnder('a: [1]\n', {}, 'yaml')).toMatchObject({ outcome: 'rows' });
  });
});

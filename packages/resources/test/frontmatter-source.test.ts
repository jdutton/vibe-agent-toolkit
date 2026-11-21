/**
 * `parseFrontmatterSource` — the ONE decode of a frontmatter block, run in the
 * parse worker. Its result carries everything the parent needs, so the parent
 * never decodes YAML: the mapping, the error, and `frontmatterNotAMapping`, the
 * one rule for "this block is valid YAML but not a mapping", read by the
 * projection's `blob_conditions` and the OKF judges.
 *
 * The line both readers depend on: a block that declares NOTHING (`~`, `null`,
 * comment-only) is not a non-mapping — it is "no value" by the document's own
 * word — while a sequence or a scalar is.
 *
 * And the line the worker depends on: a block nested deep enough to overflow
 * the thread's stack is a `stackMb` breach, so the decode THROWS it rather than
 * reporting a `frontmatterError` a cache would store as a fact of the bytes.
 */
import { describe, expect, it } from 'vitest';

import { parseFrontmatterSource } from '../src/frontmatter-source.js';
import { isStackOverflow } from '../src/parse-limits.js';

describe('parseFrontmatterSource', () => {
  it.each([
    ['a sequence', '- a\n- b'],
    ['a bare scalar', 'just a string'],
    ['a number', '42'],
  ])('flags %s as not a mapping, and nothing else', (_label, source) => {
    expect(parseFrontmatterSource(source)).toStrictEqual({ frontmatterNotAMapping: true });
  });

  it.each([
    ['a !!set', '!!set\n? a\n? b'],
    ['a !!omap', '!!omap\n- a: 1\n- b: 2'],
    ['a !!timestamp', '!!timestamp 2024-01-01'],
    ['a !!binary', '!!binary aGk='],
  ])('flags a root that decodes to %s, no plain mapping, as not a mapping', (_label, source) => {
    expect(parseFrontmatterSource(source)).toStrictEqual({ frontmatterNotAMapping: true });
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '  \n '],
    ['comment-only', '# TODO: add paths later'],
    ['a tilde', '~'],
    ['an explicit null', 'null'],
  ])('returns nothing for %s', (_label, source) => {
    expect(parseFrontmatterSource(source)).toStrictEqual({});
  });

  it('returns a mapping', () => {
    expect(parseFrontmatterSource('paths:\n  - "src/**"')).toStrictEqual({ frontmatter: { paths: ['src/**'] } });
  });

  // The whole-document parse hands over the block as the markdown parser found it, line endings
  // and all; a skill lane's block parse joins its lines with `\n`. One decode for both: a lone CR
  // and a CRLF are each a line ending, as they are to the fence rule.
  it.each([
    ['a lone CR between keys', 'name: x\rdescription: y', 'name: x\ndescription: y'],
    ['a lone-CR folded scalar', 'name: x\rdescription: >\r  a\r  b', 'name: x\ndescription: >\n  a\n  b'],
    ['CRLF', 'name: x\r\ndescription: >\r\n  a\r\n  b', 'name: x\ndescription: >\n  a\n  b'],
  ])('decodes %s as the same block with LF line endings', (_label, source, lf) => {
    expect(parseFrontmatterSource(source)).toStrictEqual(parseFrontmatterSource(lf));
  });

  it('returns invalid YAML as an error', () => {
    expect(Object.keys(parseFrontmatterSource('a: [unclosed'))).toStrictEqual(['frontmatterError']);
  });

  it('throws a stack overflow instead of reporting it as a frontmatter error', () => {
    // 8,000 levels overflow any thread's stack inside yaml's composer.
    const source = `a: ${'['.repeat(8000)}${']'.repeat(8000)}`;
    let thrown: unknown;
    try {
      parseFrontmatterSource(source);
    } catch (error) {
      thrown = error;
    }

    expect(isStackOverflow(thrown)).toBe(true);
  });
});

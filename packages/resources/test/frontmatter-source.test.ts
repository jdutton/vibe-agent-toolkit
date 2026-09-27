/**
 * `frontmatterIsNonMapping` — the ONE rule for "this block is valid YAML but
 * not a mapping", shared by the projection's `blob_conditions` and the OKF
 * judges. It used to be two private re-decodes that disagreed on a throw.
 *
 * The line both callers depend on: a block that declares NOTHING (`~`, `null`,
 * comment-only) is not a non-mapping — it is "no value" by the document's own
 * word — while a sequence or a scalar is.
 */
import { describe, expect, it } from 'vitest';

import { frontmatterIsNonMapping, parseFrontmatterSource } from '../src/frontmatter-source.js';

describe('frontmatterIsNonMapping', () => {
  it.each([
    ['a sequence', '- a\n- b'],
    ['a bare scalar', 'just a string'],
    ['a number', '42'],
  ])('flags %s', (_label, source) => {
    expect(frontmatterIsNonMapping(source)).toBe(true);
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace-only', '  \n '],
    ['comment-only', '# TODO: add paths later'],
    ['a tilde', '~'],
    ['an explicit null', 'null'],
    ['a mapping', 'paths:\n  - "src/**"'],
    ['invalid YAML', 'a: [unclosed'],
  ])('does not flag %s', (_label, source) => {
    expect(frontmatterIsNonMapping(source)).toBe(false);
  });

  // The flag and the parse are one decision: a flagged block is exactly one the
  // parse returned neither a mapping nor an error for.
  it('flags only blocks that parseFrontmatterSource returned empty for', () => {
    for (const source of ['- a', 'x', '~', '', 'a: 1', 'a: [unclosed']) {
      if (frontmatterIsNonMapping(source)) expect(parseFrontmatterSource(source)).toEqual({});
    }
  });
});

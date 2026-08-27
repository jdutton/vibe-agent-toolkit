import { describe, expect, it } from 'vitest';

import { computeContentKey, CONTENT_KEY_PATTERN } from '../src/content-key.js';

/**
 * Every kind {@link computeContentKey} can be handed, written out by hand.
 *
 * Deliberately a literal list rather than an import of the production array:
 * the pattern is DERIVED from that array, so a test that read the same array
 * would be an algebraic identity — green for any value of it, including an
 * empty one. This list is the second opinion, and `covers every kind the type
 * admits` below is what makes forgetting to update it a failure rather than a
 * silent gap.
 */
const ALL_KINDS = ['markdown', 'html', 'none'] as const;

describe('CONTENT_KEY_PATTERN', () => {
  it.each(ALL_KINDS)('matches a real computed %s content key', (kind) => {
    const key = computeContentKey(new TextEncoder().encode('hello'), kind);
    expect(CONTENT_KEY_PATTERN.test(key)).toBe(true);
  });

  it('is built from the kind list, and covers exactly it', () => {
    // A change detector ON PURPOSE. The pattern is assembled from the production
    // kind array, so it cannot go stale on its own — but THIS FILE can: add a
    // fourth kind and the acceptance cases above would silently stop covering
    // one, with everything green. No test file in this repository is
    // typechecked, so a `satisfies` clause would buy nothing here; pinning the
    // assembled source against a hand-written expectation is the check that
    // actually runs.
    //
    // If this fails because a kind was added, update `ALL_KINDS` and revisit the
    // rejection table below — do not just re-copy the new source in.
    expect(CONTENT_KEY_PATTERN.source).toBe(String.raw`^(?:markdown|html|none)\.[0-9a-f]{64}$`);
  });

  it.each([
    ['uppercase hex', 'markdown.' + 'A'.repeat(64)],
    ['wrong parser kind', 'pdf.' + '0'.repeat(64)],
    // A prefix that CONTAINS a real kind but is not one. An alternation left
    // unanchored inside the group, or widened to `\w+`, accepts these.
    ['kind with a prefix', 'xmarkdown.' + '0'.repeat(64)],
    ['kind with a suffix', 'nonetheless.' + '0'.repeat(64)],
    ['empty kind', '.' + '0'.repeat(64)],
    ['short digest', 'markdown.' + '0'.repeat(63)],
    ['long digest', 'markdown.' + '0'.repeat(65)],
    ['path traversal attempt', '..'],
    ['no digest', 'markdown.'],
  ] as const)('rejects %s', (_label, value) => {
    expect(CONTENT_KEY_PATTERN.test(value)).toBe(false);
  });
});

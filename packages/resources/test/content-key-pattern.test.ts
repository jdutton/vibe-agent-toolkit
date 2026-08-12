import { describe, expect, it } from 'vitest';

import { computeContentKey, CONTENT_KEY_PATTERN } from '../src/content-key.js';

describe('CONTENT_KEY_PATTERN', () => {
  it('matches a real computed content key', () => {
    const key = computeContentKey(new TextEncoder().encode('hello'), 'markdown');
    expect(CONTENT_KEY_PATTERN.test(key)).toBe(true);
  });

  it.each([
    ['uppercase hex', 'markdown.' + 'A'.repeat(64)],
    ['wrong parser kind', 'pdf.' + '0'.repeat(64)],
    ['short digest', 'markdown.' + '0'.repeat(63)],
    ['long digest', 'markdown.' + '0'.repeat(65)],
    ['path traversal attempt', '..'],
    ['no digest', 'markdown.'],
  ] as const)('rejects %s', (_label, value) => {
    expect(CONTENT_KEY_PATTERN.test(value)).toBe(false);
  });
});

/**
 * `vat claude context` over a path the projection never realized answers
 * `kind: unknown` — a non-answer that carries no measurement, in any format.
 */

import { describe, expect, it } from 'vitest';

import { __internal } from '../../../src/commands/claude/context.js';

describe('the unknown answer', () => {
  it('is a non-answer with no measurement, and its text says NO ANSWER', () => {
    const document = __internal.unknownDocumentFor('src/missing.ts', '/repo');

    expect(document).toMatchObject({ kind: 'unknown', input: 'src/missing.ts', reason: 'path-not-realized' });
    expect(document).not.toHaveProperty('totals');
    expect(document).not.toHaveProperty('rows');
    expect(document.explanation).toContain('/repo');

    const text = __internal.renderUnknownText(document);
    expect(text).toContain('NO ANSWER for');
    expect(text).toContain('reason: path-not-realized');
    expect(text.endsWith('\n')).toBe(true);
  });
});

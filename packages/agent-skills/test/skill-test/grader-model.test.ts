import { describe, expect, it } from 'vitest';

import { DEFAULT_CONCURRENCY, DEFAULT_GRADER_MODEL } from '../../src/skill-test/grader-model.js';

// Regression guard: these are vat-owned, pinned defaults (issue #145 spec §2.3).
// Changing them is a deliberate release decision, not an accidental edit — a
// failing test here should prompt the author to confirm the bump is intentional.
describe('grader-model defaults', () => {
  it('pins DEFAULT_GRADER_MODEL', () => {
    expect(DEFAULT_GRADER_MODEL).toBe('claude-sonnet-5');
  });

  it('pins DEFAULT_CONCURRENCY', () => {
    expect(DEFAULT_CONCURRENCY).toBe(4);
  });
});

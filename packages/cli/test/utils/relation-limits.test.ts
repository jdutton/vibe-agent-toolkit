/**
 * The stated bounds ride with a SQL answer, or the reader never sees them.
 *
 * ## The defect this pins
 *
 * `vat claude context` publishes {@link CLAUDE_CONTEXT_LIMITS} beside every
 * answer it gives, on the rule that *a limit a reader has to go and find is a
 * limit that does not reach the person acting on the number*. The same numbers
 * are reachable as `claude_context_chains` / `claude_context_loads` rows, and
 * the SQL route published NONE of them — so the lane an adopter gates their
 * build on was the lane with no caveats attached, which is the wrong way round.
 *
 * ## Why attachment is keyed on the LENS, not on the statement
 *
 * The limits bound what the relations mean. A run that evaluated no
 * claude-context lens produced no such row, so attaching them would be a
 * caveat about rows the answer does not contain — noise that teaches a reader
 * to skip the block on the runs where it matters.
 */

import { CLAUDE_CONTEXT_BOUNDS_STATEMENT, CLAUDE_CONTEXT_RELATION_LIMITS } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { CLAUDE_CONTEXT_LENS } from '../../src/utils/projection-lenses.js';
import { relationBoundsFor } from '../../src/utils/relation-limits.js';

describe('relationBoundsFor', () => {
  it('publishes the bounds statement and every relation limit when the claude-context lens ran', () => {
    const bounds = relationBoundsFor([CLAUDE_CONTEXT_LENS.name]);

    expect(bounds).toEqual({
      boundsStatement: CLAUDE_CONTEXT_BOUNDS_STATEMENT,
      limits: CLAUDE_CONTEXT_RELATION_LIMITS,
    });
  });

  it('publishes nothing when no lens ran, so a run with no such row carries no caveat about one', () => {
    expect(relationBoundsFor([])).toEqual({});
  });

  it('publishes nothing for a lens that produces no claude-context row', () => {
    expect(relationBoundsFor(['authored-link'])).toEqual({});
  });

  it('names the lens through the registry, so a renamed lens cannot silently stop publishing', () => {
    // ⛔ The literal is the thing under test: `CLAUDE_CONTEXT_LENS.name` is what
    // the run reports in `lensesEvaluated`, and a helper matching a hand-copied
    // string would keep compiling — and keep publishing nothing — after a
    // rename. Asserting the spelling here makes that rename a red test rather
    // than a silently emptied bounds block.
    expect(CLAUDE_CONTEXT_LENS.name).toBe('claude-context');
  });
});

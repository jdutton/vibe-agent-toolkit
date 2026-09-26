/**
 * `conditionLine`'s rendering — the ONLY code that prints the `why:` and
 * `reached from:` lines of a condition.
 *
 * ## Why this is a unit test and not a system assertion over a real tree
 *
 * `claude-context.system.test.ts` runs `vat claude context` against this
 * repository and passed with these two lines silently deleted: nothing there
 * asserts on the CONTENT of a condition's rendered text, only that a
 * `Conditions` section exists at all. A unit test over a hand-built
 * {@link GradedCondition} is the only thing that can pin the exact lines this
 * function renders, since a real tree's conditions are whatever they happen to
 * be that day.
 */

import type { GradedCondition } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { conditionLine } from '../../../src/commands/claude/context.js';

/**
 * A graded condition, defaulting to a `CLOSURE_REFERENCE_UNRESOLVED` warning
 * with a chain — the shape most of `conditionLine`'s lines have something to
 * render for.
 *
 * @param overrides - The fields this case is actually about
 * @returns The condition
 */
function condition(overrides: Partial<GradedCondition> = {}): GradedCondition {
  return {
    code: 'CLOSURE_REFERENCE_UNRESOLVED',
    severity: 'warning',
    harness: 'claude-code',
    path: 'wiki/records.md',
    subject: null,
    line: 1,
    ref: '@docs/missing.md',
    message: 'Reference "@docs/missing.md" at line 1 resolves to no realization in this projection',
    why: 'Claude Code silently skips a missing import.',
    affects: { chain: ['CLAUDE.md', 'wiki/records.md'], hop: 1 },
    ...overrides,
  };
}

describe('conditionLine', () => {
  it('renders severity, code, location, ref and message on the first line', () => {
    const rendered = conditionLine(condition());
    const [first] = rendered.split('\n');

    expect(first).toContain('warning');
    expect(first).toContain('CLOSURE_REFERENCE_UNRESOLVED');
    expect(first).toContain('wiki/records.md:1');
    expect(first).toContain('[@docs/missing.md]');
    expect(first).toContain('resolves to no realization');
  });

  it('renders an indented why: line naming the loader rule', () => {
    const rendered = conditionLine(condition());

    expect(rendered).toContain('why: Claude Code silently skips a missing import.');
  });

  it('renders an indented reached from: line tracing the chain and hop', () => {
    const rendered = conditionLine(condition());

    expect(rendered).toContain('reached from: CLAUDE.md → wiki/records.md (hop 1)');
  });

  it('omits reached from: entirely when affects is null', () => {
    const rendered = conditionLine(condition({ affects: null }));

    expect(rendered).not.toContain('reached from:');
  });

  it('renders an indented subject: line naming the refused/escaping target when one differs from path', () => {
    const rendered = conditionLine(condition({
      code: 'CLOSURE_REFERENCE_OUTSIDE_ROOT',
      subject: '../shared.md',
      why: 'Claude Code loads it only with external includes approved.',
    }));

    expect(rendered).toContain('subject: ../shared.md');
  });

  it('omits subject: entirely when subject is null', () => {
    const rendered = conditionLine(condition({ subject: null }));

    expect(rendered).not.toContain('subject:');
  });

  // ⛔ Proves each line is really there rather than accidentally satisfied by a
  // substring of another line — `why:` alone would also match a message that
  // happens to contain the word, so the count matters as much as the content.
  it('renders exactly four lines when subject, why and affects are all present', () => {
    const rendered = conditionLine(condition({ subject: '../shared.md' })).split('\n');

    expect(rendered).toHaveLength(4);
  });

  it('renders exactly two lines (main + why) when subject and affects are both absent', () => {
    const rendered = conditionLine(condition({ subject: null, affects: null })).split('\n');

    expect(rendered).toHaveLength(2);
  });
});

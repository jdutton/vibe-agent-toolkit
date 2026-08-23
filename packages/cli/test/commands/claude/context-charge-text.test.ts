/**
 * The one rendering rule in `vat claude context` that no other layer enforces:
 * an UNKNOWN size is never printed as a zero.
 *
 * ## Why this is a unit test and not a system assertion over the JSON rows
 *
 * A system test can only assert over the document a real tree produces, and on a
 * real tree every row has a measured blob — so `row.tokens === null` is `false`
 * everywhere and an assertion pairing it with `charge === 'unknown-size'`
 * compares `false === false` on every row and passes VACUOUSLY. Worse, that
 * pairing is a property of `account()` in `@vibe-agent-toolkit/resources`, which
 * already pins it directly; it says nothing about the renderer. The only code
 * that can print a `0` for an unmeasured file is {@link chargeText}, so that is
 * what is called here — with the null the real tree never supplies.
 *
 * ⛔ The assertion is deliberately two-sided: the phrase must appear AND the
 * string must not contain a bare `0`. A `${row.tokens ?? 0} tokens` introduced
 * into the renderer fails this test on both halves.
 */

import type { AccountedRow } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { chargeText } from '../../../src/commands/claude/context.js';

/**
 * An accounted row, defaulting to a measured one.
 *
 * @param overrides - The fields this case is actually about
 * @returns The row
 */
function accountedRow(overrides: Partial<AccountedRow>): AccountedRow {
  return {
    resourceId: 'id:CLAUDE.md',
    path: 'CLAUDE.md',
    tokens: 100,
    bytes: 400,
    loadClass: 'always',
    admissions: [{ kind: 'ancestry', dir: '' }],
    charge: 'charged',
    ...overrides,
  };
}

describe('chargeText', () => {
  it('renders an unknown size as words, NEVER as a zero', () => {
    const rendered = chargeText(accountedRow({ tokens: null, bytes: null, charge: 'unknown-size' }));

    expect(rendered).toContain('size unknown');
    // ⛔ The half that fails on `?? 0`: a confident zero is indistinguishable
    // from a measured one, so no digit may appear at all.
    expect(rendered).not.toMatch(/\d/);
  });

  it('refuses to invent a number even if a null reaches the charged branch', () => {
    // `chargeOf` classifies a blobless row `unknown-size` before this is called,
    // so this pairing cannot arise today. It is asserted anyway: the guard in
    // the renderer is a VALUE test rather than a trust in that ordering, and a
    // `?? 0` would be invisible from the outside until the ordering changed.
    const rendered = chargeText(accountedRow({ tokens: null, bytes: null, charge: 'charged' }));

    expect(rendered).toContain('size unknown');
    expect(rendered).not.toMatch(/\d/);
  });

  it('prints the measured count for a charged row', () => {
    expect(chargeText(accountedRow({ tokens: 42 }))).toBe('42 tokens');
  });

  it('says why a skipped or pruned row costs nothing, without a count', () => {
    const skipped = chargeText(accountedRow({ charge: 'oversize-skipped' }));
    const pruned = chargeText(accountedRow({ charge: 'pruned-by-oversize' }));

    expect(skipped).toContain('4 MiB');
    expect(pruned).toContain('not reached');
    // Both rows carry a non-null `tokens`, so a renderer that fell through to
    // the count would silently charge for bytes the harness never loaded.
    expect(skipped).not.toContain('tokens');
    expect(pruned).not.toContain('tokens');
  });
});

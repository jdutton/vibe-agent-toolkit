/**
 * The `Token estimate` section's "of which" line — the header + preamble
 * share of `alwaysTokens`/`onDemandTokens`, printed so a reader can see how
 * much of the total is RENDERING overhead rather than measured content.
 *
 * ## Why this is a unit test over hand-built rows
 *
 * `ContextTotals.headerTokens` and `.preambleTokens` are both facts
 * `@vibe-agent-toolkit/resources` computes (`account()`'s `totalsOf`); what is
 * under test HERE is only that the CLI's renderer prints them, unmodified, in
 * the wording that names both the header and preamble shares — never that the numbers themselves are
 * right, which is that package's own suite to pin. Rows are hand-built with
 * a manufactured `headerTokens` so the assertion is not vacuously true on a
 * real tree where every header happens to be non-zero anyway.
 */

import type { LoadedContextAnswer } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { answerDocument, renderEnvelopeText } from '../../../src/commands/claude/context.js';
import { emptyClaudeContextProjection } from '../../helpers/empty-claude-context-projection.js';

describe('estimateLines — the header + preamble share of the totals', () => {
  it('prints headers and preamble as an explicit share, never merged silently into the totals above', () => {
    const answer: LoadedContextAnswer = {
      kind: 'answer',
      input: 'acme',
      directory: 'acme',
      file: null,
      rows: [
        {
          resourceId: 'id:CLAUDE.md',
          path: 'acme/CLAUDE.md',
          tokens: 10,
          bytes: 40,
          loadClass: 'always',
          admissions: [{ kind: 'ancestry', dir: 'acme', local: false }],
          headerTokens: 30,
        },
        {
          resourceId: 'id:rule',
          path: '.claude/rules/x.md',
          tokens: 5,
          bytes: 20,
          loadClass: 'on-demand',
          admissions: [{ kind: 'glob-rule', pattern: '*.ts' }],
          headerTokens: 8,
        },
      ],
      conditions: [],
      overBudgetRules: [],
      unattributedImports: [],
    };

    const document = answerDocument(answer, emptyClaudeContextProjection(), false);

    // The positive control: headerTokens is the SUM over every row regardless
    // of load class (30 + 8), and preambleTokens is non-zero because the
    // `always` row is genuinely charged — both computed by
    // `@vibe-agent-toolkit/resources`, read here rather than recomputed.
    expect(document.totals.headerTokens).toBe(38);
    expect(document.totals.preambleTokens).toBeGreaterThan(0);

    const text = renderEnvelopeText([document]);

    expect(text).toContain(
      `of which: headers     38 tokens · preamble ${document.totals.preambleTokens} tokens`
      + ' (both already counted above)',
    );
    // The wording must not claim to be ONLY a preamble line — it names the
    // header share too, and a regression that dropped `headerTokens`
    // from the line would still print SOME number, so the count 38 is what
    // actually pins it rather than mere presence of the word "headers".
  });
});

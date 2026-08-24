/**
 * `vat rag index` must not report `success` over a run that dropped documents.
 *
 * The command used to publish a HARDCODED `status: 'success'` and an
 * UNCONDITIONAL `process.exit(0)`, no matter what `indexResources` put in
 * `errors`. Observed against this repo's own `docs/`: two resources failed to
 * index, their content became unsearchable, and the report still said
 * `status: success` with exit 0 — nothing a CI step could fail on.
 *
 * The mapping from an index result to `{ status, exitCode }` is pure, so it is
 * pinned here rather than through a CLI spawn plus a real vector database.
 * `errors` is optional on `IndexResult`, so BOTH the `undefined` and the `[]`
 * shapes have to land on success — the old code guarded
 * `errors && errors.length > 0`, and a rewrite that reads only `.length` would
 * throw on the shape the provider actually returns when nothing failed.
 */

import { describe, expect, it } from 'vitest';

import { indexOutcome } from '../../../src/commands/rag/index-command.js';

/** One failure entry, in the shape `IndexResult['errors']` declares. */
function failure(resourceId: string): { resourceId: string; error: string } {
  return { resourceId, error: 'A single line of 308 tokens exceeds the chunk budget' };
}

describe('indexOutcome', () => {
  it('reports success and exit 0 when errors is undefined', () => {
    expect(indexOutcome({})).toEqual({ status: 'success', exitCode: 0 });
  });

  it('reports success and exit 0 when errors is an empty array', () => {
    expect(indexOutcome({ errors: [] })).toEqual({ status: 'success', exitCode: 0 });
  });

  // One failed resource and several are the same decision; a table rather than
  // two near-identical blocks, which this repo's duplication gate rejects.
  it.each([
    ['a single failed resource', ['docs-validation-codes-md']],
    ['several failed resources', ['docs-validation-codes-md', 'docs-writing-tests-md', 'readme-md']],
  ])('reports partial and a non-zero exit for %s', (_label, resourceIds) => {
    const outcome = indexOutcome({ errors: resourceIds.map(failure) });

    expect(outcome).toEqual({ status: 'partial', exitCode: 1 });
  });

  it('uses exit 1, the reported-outcome code, not 2 which means system error', () => {
    // Partially-indexed-with-errors is a REPORTED outcome: the report is on
    // stdout and is complete. 2 is reserved for a command that could not run.
    expect(indexOutcome({ errors: [failure('anything')] }).exitCode).toBe(1);
  });
});

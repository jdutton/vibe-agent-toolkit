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

import { indexOutcome, unreadableIndexErrors } from '../../../src/commands/rag/index-command.js';

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

/**
 * A resource the crawl enumerated but could not READ never reaches
 * `indexResources`, so it is in none of the provider's counters and not in
 * its `errors` — the registry logs it (`getUnreadableResources()`) and no
 * command read that log. `vat rag index` published `status: success` over a
 * corpus with a document missing from it. The log is folded into the same
 * `errors` list the provider's failures land in, so one status covers both.
 */
describe('unreadableIndexErrors', () => {
  const root = '/srv/project';

  it('maps nothing to nothing', () => {
    expect(unreadableIndexErrors([], root)).toEqual([]);
  });

  it('names each file relative to the crawl root, with the reason', () => {
    const errors = unreadableIndexErrors(
      [
        { filePath: `${root}/docs/bad.md`, reason: 'EACCES: permission denied', code: 'EACCES' },
        { filePath: `${root}/docs/gone.md`, reason: 'ENOENT: no such file' },
      ],
      root,
    );

    expect(errors.map((e) => e.resourceId)).toEqual(['docs/bad.md', 'docs/gone.md']);
    expect(errors[0]?.error).toContain('EACCES: permission denied');
    expect(errors[1]?.error).toContain('ENOENT: no such file');
    // The entry has to say the document is NOT in the index, not merely that a read failed.
    for (const entry of errors) expect(entry.error).toMatch(/not (?:in the index|indexed)/u);
  });

  it('turns a run with an unreadable resource into partial / exit 1 through indexOutcome', () => {
    const errors = unreadableIndexErrors([{ filePath: `${root}/docs/bad.md`, reason: 'EACCES' }], root);

    expect(indexOutcome({ errors })).toEqual({ status: 'partial', exitCode: 1 });
  });
});

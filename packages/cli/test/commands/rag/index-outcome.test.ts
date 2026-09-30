/**
 * `vat rag index` must not report a clean run over one that dropped documents.
 *
 * The command used to publish a HARDCODED `status: 'success'` and an
 * UNCONDITIONAL `process.exit(0)`, no matter what `indexResources` put in
 * `errors`. Observed against this repo's own `docs/`: two resources failed to
 * index, their content became unsearchable, and the report still said success
 * with exit 0 — nothing a CI step could fail on.
 *
 * Each resource the index does not hold is now a `RAG_DOCUMENT_INDEX_FAILED`
 * finding at its path, and the exit code is DERIVED from the report. The
 * mapping is pure, so it is pinned here rather than through a CLI spawn plus a
 * real vector database. `errors` is optional on `IndexResult`, so BOTH the
 * `undefined` and the `[]` shapes have to be a clean run.
 */

import { exitCodeForReport, toFindings } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { buildIndexReport, providerIndexIssues, unreadableIndexIssues } from '../../../src/commands/rag/index-command.js';
import { RAG_INDEX_REPORT_SCHEMA } from '../../../src/commands/rag/index-schema.js';

const ROOT = safePath.resolve('/srv/project');

const COUNTS = {
  resourcesIndexed: 1,
  resourcesSkipped: 0,
  resourcesEmpty: 0,
  resourcesUpdated: 0,
  chunksCreated: 3,
  chunksDeleted: 0,
};

/** One failure entry, in the shape `IndexResult['errors']` declares. */
function failure(resourceId: string): { resourceId: string; error: string } {
  return { resourceId, error: 'A single line of 308 tokens exceeds the chunk budget' };
}

describe('buildIndexReport', () => {
  it('is ok, exit 0, with no issue, and publishes exactly the six counters', () => {
    const report = buildIndexReport({ examined: 1, result: COUNTS, issues: [], durationMs: 9 });

    expect(RAG_INDEX_REPORT_SCHEMA.parse(report).status).toBe('ok');
    expect(exitCodeForReport(report)).toBe(0);
    expect(report.data).toStrictEqual({ resourcesIndexed: 1, resourcesSkipped: 0, resourcesEmpty: 0, resourcesUpdated: 0, chunksCreated: 3, chunksDeleted: 0 });
  });

  it('rag index with one failed document is a findings report, exit 1', () => {
    const locations = new Map([['docs-guide', 'docs/guide.md']]);
    const issues = providerIndexIssues([failure('docs-guide')], locations);
    const report = buildIndexReport({ examined: 2, result: COUNTS, issues, durationMs: 9 });

    RAG_INDEX_REPORT_SCHEMA.parse(report);
    expect(report.status).toBe('findings');
    expect(report.findings).toStrictEqual(toFindings(issues));
    expect(report.findings).toMatchObject([{ code: 'RAG_DOCUMENT_INDEX_FAILED', severity: 'error', location: 'docs/guide.md' }]);
    // A REPORTED outcome — the counters for what did land are all there — so 1, never 2.
    expect(exitCodeForReport(report)).toBe(1);
  });
});

describe('providerIndexIssues', () => {
  // `errors` is optional on `IndexResult`, so a provider MAY omit it; both shapes are "nothing failed".
  it.each([
    ['errors is undefined', undefined],
    ['errors is empty', []],
  ])('is no issue when %s', (_label, errors) => {
    expect(providerIndexIssues(errors, new Map())).toEqual([]);
  });

  it('locates a failure at its resource path, and falls back to the id the registry never mapped', () => {
    const issues = providerIndexIssues([failure('known'), failure('orphan')], new Map([['known', 'docs/known.md']]));

    expect(issues.map((issue) => issue.location)).toEqual(['docs/known.md', 'orphan']);
    for (const issue of issues) expect(issue.message).toContain('308 tokens');
  });
});

/**
 * A resource the crawl enumerated but could not READ never reaches
 * `indexResources`, so it is in none of the provider's counters and not in its
 * `errors` — the registry logs it (`getUnreadableResources()`). It is the same
 * finding as a provider failure: the document is not in the index.
 */
describe('unreadableIndexIssues', () => {
  it('maps nothing to nothing', () => {
    expect(unreadableIndexIssues([], ROOT)).toEqual([]);
  });

  it('locates each file relative to the crawl root, with the reason', () => {
    const issues = unreadableIndexIssues(
      [
        { filePath: safePath.join(ROOT, 'docs/bad.md'), reason: 'EACCES: permission denied', code: 'EACCES' },
        { filePath: safePath.join(ROOT, 'docs/gone.md'), reason: 'ENOENT: no such file' },
      ],
      ROOT,
    );

    expect(issues.map((issue) => issue.location)).toEqual(['docs/bad.md', 'docs/gone.md']);
    expect(issues.map((issue) => issue.code)).toEqual(['RAG_DOCUMENT_INDEX_FAILED', 'RAG_DOCUMENT_INDEX_FAILED']);
    expect(issues[0]?.message).toContain('EACCES: permission denied');
    expect(issues[1]?.message).toContain('ENOENT: no such file');
    // The finding has to say the document is NOT in the index, not merely that a read failed.
    for (const issue of issues) expect(issue.message).toMatch(/not in the index/u);
  });
});

/**
 * The store-size arm, run by the built candidate over a three-commit subject
 * whose third commit adds a markdown file that produces rows: one row per
 * commit, oldest first, and the third commit grows the carried store by at
 * least half of what the same file adds to a fresh store.
 *
 * System-tier: real git, the built vat, a store read through node:sqlite.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { runStoreSizeArm, type StoreSizeReport } from '../../src/facets/perf/store-size.js';
import { runGit } from '../../src/harness/git-state.js';
import { commitAll, git, writeFixtureFile } from '../git-fixtures.js';
import { cleanupVerdictFixtures, tempDir } from '../integration/verdict-fixtures.js';

import { CANDIDATE_VAT, candidateSubject } from './candidate-subject.js';

afterAll(cleanupVerdictFixtures);

/** The store holds facts per heading and per link, not content: 2,000 of each. */
const ROWS = 2000;

/** @returns A markdown file of {@link ROWS} headings, each with one link */
function rowHeavyDocument(): string {
  const sections = Array.from({ length: ROWS }, (_, index) => `## Heading ${String(index)}\n\nSee [the guide](guide.md).\n`);
  return `# Big\n\n${sections.join('\n')}`;
}

/** @returns A subject of three commits: the candidate subject, a page, the row-heavy file */
function threeCommitSubject(): string {
  const root = candidateSubject({});
  writeFixtureFile(root, 'docs/page.md', '# Page\n\nSee [the guide](guide.md).\n');
  commitAll(root, 'page');
  writeFixtureFile(root, 'docs/big.md', rowHeavyDocument());
  commitAll(root, 'big');
  return root;
}

/**
 * @param subject - A repository
 * @param commits - Commits to replay
 * @returns The arm's report, in a fresh arms root
 */
function storeSize(subject: string, commits: number): Promise<StoreSizeReport> {
  return runStoreSizeArm(subject, { alias: 'b', instrument: CANDIDATE_VAT }, { armsRoot: tempDir('lab-store-size-'), commits, timeoutMs: undefined });
}

/**
 * @param report - A one-commit report
 * @returns The fresh store's bytes
 */
function freshBytes(report: StoreSizeReport): number {
  const [row] = report.perCommit;
  if (row === undefined) throw new Error('a one-commit report has no row');
  return row.storeBytes;
}

describe('perf store-size: store bytes over replayed commits', () => {
  it('grows the carried store by at least half of what the row-heavy file adds to a fresh one', async () => {
    const subject = threeCommitSubject();
    const report = await storeSize(subject, 3);

    const expected = runGit(['rev-list', '--first-parent', '-n', '3', '--reverse', 'HEAD'], subject).stdout.trim().split('\n');
    expect(report.perCommit.map((row) => row.commit)).toEqual(expected);
    expect(report.perCommit.map((row) => row.exitCode)).toEqual([0, 0, 0]);

    // What the file adds to a fresh store: a fresh store of HEAD against one of HEAD~1.
    const before = tempDir('lab-store-size-before-');
    git(['clone', '--quiet', subject, before], subject);
    git(['reset', '--quiet', '--hard', 'HEAD~1'], before);
    const added = freshBytes(await storeSize(subject, 1)) - freshBytes(await storeSize(before, 1));
    expect(added).toBeGreaterThan(0);

    const [, second, third] = report.perCommit;
    expect(second?.storeBytes).toBeGreaterThan(0);
    expect((third?.storeBytes ?? 0) - (second?.storeBytes ?? 0)).toBeGreaterThanOrEqual(added / 2);
  });
});
